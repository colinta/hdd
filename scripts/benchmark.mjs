#!/usr/bin/env node
// Benchmarks the compiled disk usage scanner against real directory trees.
// Run `pnpm bench --help` for usage.
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {cp, mkdir, rm, writeFile} from 'node:fs/promises';
import {cpus, homedir, release, totalmem, type as osType} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workerPath = join(projectRoot, 'scripts', 'benchmark-worker.mjs');
const benchmarkDir = join(projectRoot, '.benchmarks');
const buildsDir = join(benchmarkDir, 'builds');
const resultsDir = join(benchmarkDir, 'results');
const RESULT_PREFIX = 'BENCH_RESULT ';
const LEFT_ALIGNED_COLUMNS = new Set(['variant', 'refresh', 'path']);

const HELP = `Usage: pnpm bench [options] [target...]

Builds the project (via the pnpm script), then scans each target in fresh Node processes.
Default targets: ~/src and ~/world/trees (missing targets are skipped).

Options:
  --runs N              Measured samples per target, scenario, and variant (default 3)
  --warmup N            Untimed scans per target before sampling, to warm caches (default 1)
  --scenario LIST       Comma-separated: headless, ui (default headless,ui)
                          headless  scan only, like \`hdd -p\`
                          ui        also prepare a report, rankings, and root rows for every
                                    progress notification, like App.tsx does
  --impl SPEC           Implementation to benchmark; repeat to compare (default current)
                          current     the fresh build in .dist
                          NAME        a build saved with --save-build NAME
                          NAME=DIR    any directory containing disk-usage.js
  --uv-threadpool LIST  Run every implementation with each UV_THREADPOOL_SIZE, e.g. 4,8,16
  --refresh-count N     After each scan, refresh the N largest directories at the first level
                        with siblings, plus the largest ranked directory, verifying that parent
                        totals change by exactly the refreshed amount (default 3; 0 = off)
  --refresh-root        Also time refreshing the whole root after the scan
  --verify              Walk every entry after each scan to check tree invariants (slow)
  --reference du        Also time \`du -sk TARGET\` once per run for comparison
  --timeout SECONDS     Per-sample timeout (default 900)
  --label NAME          Label included in the results file name
  --output PATH         Also write the results JSON to PATH
  --save-build NAME     Copy the current .dist to .benchmarks/builds/NAME and exit
  -h, --help            Show this help

Examples:
  pnpm bench --runs 1 ~/src                       quick check
  pnpm bench --save-build baseline                snapshot the current implementation
  pnpm bench --impl baseline --impl current       interleaved A/B comparison
  pnpm bench --uv-threadpool 4,8,16 --scenario headless
`;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(HELP);
} else if (options.saveBuild) {
  await saveBuild(options.saveBuild);
} else {
  await runBenchmarks(options);
}

function parseArgs(args) {
  const parsed = {
    help: false,
    runs: 3,
    warmup: 1,
    scenarios: ['headless', 'ui'],
    impls: [],
    uvThreadpools: [null],
    refreshCount: 3,
    refreshRoot: false,
    verify: false,
    references: [],
    timeoutSeconds: 900,
    label: '',
    output: '',
    saveBuild: '',
    targets: [],
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (next === undefined) {
        fail(`${arg} requires a value`);
      }
      return next;
    };
    switch (arg) {
      case '--':
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--runs':
        parsed.runs = positiveInteger(arg, value(), 1);
        break;
      case '--warmup':
        parsed.warmup = positiveInteger(arg, value(), 0);
        break;
      case '--scenario':
      case '--scenarios':
        parsed.scenarios = list(value());
        for (const scenario of parsed.scenarios) {
          if (scenario !== 'headless' && scenario !== 'ui') {
            fail(`Unknown scenario: ${scenario}`);
          }
        }
        break;
      case '--impl':
        parsed.impls.push(value());
        break;
      case '--uv-threadpool':
        parsed.uvThreadpools = list(value()).map(size => String(positiveInteger(arg, size, 1)));
        break;
      case '--refresh-count':
        parsed.refreshCount = positiveInteger(arg, value(), 0);
        break;
      case '--refresh-root':
        parsed.refreshRoot = true;
        break;
      case '--verify':
        parsed.verify = true;
        break;
      case '--reference':
        parsed.references.push(value());
        break;
      case '--timeout':
        parsed.timeoutSeconds = positiveInteger(arg, value(), 1);
        break;
      case '--label':
        parsed.label = value().replace(/[^\w.-]+/g, '-');
        break;
      case '--output':
        parsed.output = resolve(expandHome(value()));
        break;
      case '--save-build':
        parsed.saveBuild = validName(value());
        break;
      default:
        if (arg.startsWith('-')) {
          fail(`Unknown option: ${arg}`);
        }
        parsed.targets.push(resolve(expandHome(arg)));
    }
  }

  for (const reference of parsed.references) {
    if (reference !== 'du') {
      fail(`Unknown reference: ${reference} (supported: du)`);
    }
  }
  if (!parsed.impls.length) {
    parsed.impls.push('current');
  }
  return parsed;
}

async function saveBuild(name) {
  const source = join(projectRoot, '.dist');
  if (!existsSync(join(source, 'disk-usage.js'))) {
    fail('No build found in .dist; run `pnpm run build` first');
  }
  const destination = join(buildsDir, name);
  await rm(destination, {recursive: true, force: true});
  await mkdir(buildsDir, {recursive: true});
  await cp(source, destination, {recursive: true});
  await writeFile(
    join(destination, 'benchmark-build.json'),
    JSON.stringify({name, savedAt: new Date().toISOString(), git: gitInfo()}, null, 2) + '\n',
  );
  console.log(`Saved .dist as ${relative(projectRoot, destination)}`);
}

async function runBenchmarks(opts) {
  const targets = opts.targets.length
    ? opts.targets
    : [join(homedir(), 'src'), join(homedir(), 'world', 'trees')];
  const existingTargets = targets.filter(target => {
    if (existsSync(target)) {
      return true;
    }
    console.warn(`Skipping missing target: ${target}`);
    return false;
  });
  if (!existingTargets.length) {
    fail('No targets to benchmark');
  }

  const variants = [];
  for (const spec of opts.impls) {
    const impl = resolveImplementation(spec);
    for (const uvThreadpool of opts.uvThreadpools) {
      variants.push({
        ...impl,
        uvThreadpool,
        name: uvThreadpool ? `${impl.name}/uv${uvThreadpool}` : impl.name,
      });
    }
  }

  const startedAt = new Date();
  const samples = [];
  const perTarget = opts.scenarios.length * variants.length * opts.runs;
  const totalSamples = existingTargets.length * (perTarget + opts.warmup);
  let sampleNumber = 0;

  console.log(
    `Benchmarking ${variants.map(variant => variant.name).join(', ')} on ` +
      `${existingTargets.map(displayPath).join(', ')} ` +
      `(${opts.runs} run${opts.runs === 1 ? '' : 's'}, scenarios: ${opts.scenarios.join(', ')})`,
  );

  for (const target of existingTargets) {
    for (let warmup = 1; warmup <= opts.warmup; warmup++) {
      sampleNumber += 1;
      const label = `[${sampleNumber}/${totalSamples}] ${displayPath(target)} warmup ${warmup}`;
      process.stdout.write(`${label} … `);
      const result = await runSample(variants[0], target, 'headless', opts, 0, false);
      console.log(`${formatMs(result.scan.wallMs)}, ${formatCount(result.scan.entries)} entries`);
    }

    for (let run = 1; run <= opts.runs; run++) {
      for (const reference of opts.references) {
        const result = await runReference(reference, target, opts.timeoutSeconds);
        samples.push({target, scenario: 'reference', variant: `ref:${reference}`, run, ...result});
        console.log(`    reference ${reference}: ${formatMs(result.scan.wallMs)}`);
      }

      for (const scenario of opts.scenarios) {
        // Rotate variant order each run so neither implementation always benefits from cache
        // state or thermal conditions left by the other.
        const ordered = rotate(variants, run - 1);
        for (const variant of ordered) {
          sampleNumber += 1;
          const label =
            `[${sampleNumber}/${totalSamples}] ${displayPath(target)} ${scenario} ` +
            `${variant.name} run ${run}`;
          process.stdout.write(`${label} … `);
          const result = await runSample(
            variant,
            target,
            scenario,
            opts,
            opts.refreshCount,
            opts.refreshRoot,
          );
          samples.push({target, scenario, variant: variant.name, run, ...result});
          const refreshMs = sum(result.refreshes.map(refresh => refresh.wallMs));
          console.log(
            `${formatMs(result.scan.wallMs)}, ${formatCount(result.scan.entries)} entries` +
              (result.refreshes.length ? `, refreshes ${formatMs(refreshMs)}` : ''),
          );
        }
      }
    }
  }

  const output = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    options: {...opts, targets: existingTargets},
    environment: environmentInfo(),
    variants: variants.map(({name, dir, uvThreadpool, metadata}) => ({
      name,
      dir: relative(projectRoot, dir) || '.',
      uvThreadpool,
      metadata,
    })),
    samples,
  };

  printSummary(output);

  await mkdir(resultsDir, {recursive: true});
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(resultsDir, `${stamp}${opts.label ? `-${opts.label}` : ''}.json`);
  await writeFile(resultsPath, JSON.stringify(output, null, 2) + '\n');
  if (opts.output) {
    await writeFile(opts.output, JSON.stringify(output, null, 2) + '\n');
  }
  console.log(`\nSaved ${relative(projectRoot, resultsPath)}`);
}

function resolveImplementation(spec) {
  let name = spec;
  let dir;
  if (spec.includes('=')) {
    const separator = spec.indexOf('=');
    name = validName(spec.slice(0, separator));
    dir = resolve(expandHome(spec.slice(separator + 1)));
  } else if (spec === 'current') {
    dir = join(projectRoot, '.dist');
  } else {
    dir = join(buildsDir, validName(spec));
  }

  if (!existsSync(join(dir, 'disk-usage.js'))) {
    fail(`Implementation "${name}" has no disk-usage.js in ${dir}`);
  }
  const metadataPath = join(dir, 'benchmark-build.json');
  const metadata =
    spec === 'current'
      ? {name, git: gitInfo()}
      : existsSync(metadataPath)
        ? JSON.parse(readFileSync(metadataPath, 'utf8'))
        : null;
  return {name, dir, metadata};
}

function runSample(variant, target, scenario, opts, refreshCount, refreshRoot) {
  const config = {
    implementationDir: variant.dir,
    target,
    scenario,
    refreshCount,
    refreshRoot,
    verify: opts.verify,
    topCount: 10,
  };
  const env = {...process.env};
  if (variant.uvThreadpool) {
    env.UV_THREADPOOL_SIZE = variant.uvThreadpool;
  } else {
    delete env.UV_THREADPOOL_SIZE;
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', workerPath, JSON.stringify(config)], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Sample timed out after ${opts.timeoutSeconds}s`));
    }, opts.timeoutSeconds * 1000);

    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      const line = stdout.split('\n').find(candidate => candidate.startsWith(RESULT_PREFIX));
      if (code !== 0 || !line) {
        reject(new Error(`Benchmark worker failed (exit ${code})\n${stderr || stdout}`));
        return;
      }
      resolvePromise(JSON.parse(line.slice(RESULT_PREFIX.length)));
    });
  });
}

function runReference(reference, target, timeoutSeconds) {
  return new Promise((resolvePromise, reject) => {
    const start = performance.now();
    const child = spawn('/usr/bin/du', ['-sk', target], {stdio: ['ignore', 'pipe', 'ignore']});
    let stdout = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000);
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timeout);
      const kilobytes = Number.parseInt(stdout, 10);
      resolvePromise({
        scan: {
          wallMs: performance.now() - start,
          size: Number.isFinite(kilobytes) ? kilobytes * 1024 : null,
        },
        refreshes: [],
      });
    });
  });
}

function printSummary(output) {
  const samplesByTarget = groupBy(output.samples, sample => sample.target);
  for (const [target, targetSamples] of samplesByTarget) {
    console.log(`\n${displayPath(target)}`);
    printFingerprint(targetSamples.filter(sample => sample.scenario !== 'reference'));

    for (const [scenario, scenarioSamples] of groupBy(targetSamples, sample => sample.scenario)) {
      const byVariant = [...groupBy(scenarioSamples, sample => sample.variant)];
      const baseline = byVariant[0];
      console.log(`\n  ${scenario}`);

      if (scenario === 'reference') {
        printTable(
          ['variant', 'wall median', 'range', 'size'],
          byVariant.map(([variant, samples]) => {
            const walls = samples.map(sample => sample.scan.wallMs);
            return [
              variant,
              formatMs(median(walls)),
              formatRange(walls, formatMs),
              formatBytes(median(samples.map(sample => sample.scan.size ?? 0))),
            ];
          }),
        );
        continue;
      }

      const headers = [
        'variant',
        'scan median',
        'range',
        'vs first',
        'entries/s',
        'cpu user+sys',
        'max RSS',
        'retained',
        'loop p99/max',
      ];
      if (scenario === 'ui') {
        headers.push('ui work', 'ui max');
      }
      printTable(
        headers,
        byVariant.map(([variant, samples]) => {
          const walls = samples.map(sample => sample.scan.wallMs);
          const baselineWalls = baseline[1].map(sample => sample.scan.wallMs);
          const row = [
            variant,
            formatMs(median(walls)),
            formatRange(walls, formatMs),
            variant === baseline[0] ? '' : formatChange(walls, baselineWalls),
            formatCount(
              median(samples.map(sample => sample.scan.entries / (sample.scan.wallMs / 1000))),
            ),
            `${formatMs(median(samples.map(sample => sample.scan.cpuUserMs)))}+` +
              formatMs(median(samples.map(sample => sample.scan.cpuSystemMs))),
            formatBytes(median(samples.map(sample => sample.process.maxRssBytes))),
            // JS heap plus off-heap buffers (the entry store's typed arrays) after GC.
            formatBytes(
              median(
                samples.map(
                  sample =>
                    sample.process.heapUsedAfterScanBytes + sample.process.externalAfterScanBytes,
                ),
              ),
            ),
            `${formatMs(median(samples.map(sample => sample.scan.eventLoopDelay.p99Ms)))}/` +
              formatMs(median(samples.map(sample => sample.scan.eventLoopDelay.maxMs))),
          ];
          if (scenario === 'ui') {
            row.push(
              formatMs(median(samples.map(sample => sample.scan.ui.totalMs))),
              formatMs(median(samples.map(sample => sample.scan.ui.maxMs))),
            );
          }
          return row;
        }),
      );

      printRefreshSummary(byVariant);
      printConsistencyProblems(scenarioSamples);
    }
  }
}

function printFingerprint(samples) {
  const entries = samples.map(sample => sample.scan.entries);
  const sizes = samples.map(sample => sample.scan.size);
  const errors = samples.map(sample => sample.scan.errors);
  const entrySpread = Math.max(...entries) - Math.min(...entries);
  const sizeSpread = Math.max(...sizes) - Math.min(...sizes);
  console.log(
    `  ${formatCount(median(entries))} entries, ${formatBytes(median(sizes))}, ` +
      `${formatCount(median(errors))} errors`,
  );
  if (entrySpread || sizeSpread) {
    console.log(
      `  ⚠ results vary across samples: ${formatCount(entrySpread)} entries, ` +
        `${formatBytes(sizeSpread)} (the tree may be changing)`,
    );
  }
}

function printRefreshSummary(byVariant) {
  const rows = [];
  for (const [variant, samples] of byVariant) {
    const byPath = groupBy(
      samples.flatMap(sample => sample.refreshes),
      refresh => `${refresh.kind}\0${refresh.path}`,
    );
    for (const refreshes of byPath.values()) {
      const [first] = refreshes;
      const walls = refreshes.map(refresh => refresh.wallMs);
      rows.push([
        variant,
        first.kind,
        truncateMiddle(first.path, 48),
        String(first.depth),
        formatCount(median(refreshes.map(refresh => refresh.entries))),
        formatMs(median(walls)),
        formatRange(walls, formatMs),
      ]);
    }
  }
  if (!rows.length) {
    return;
  }
  console.log('');
  printTable(['variant', 'refresh', 'path', 'depth', 'entries', 'median', 'range'], rows, 4);
}

function printConsistencyProblems(samples) {
  const problems = [];
  for (const sample of samples) {
    const where = `${sample.variant} run ${sample.run}`;
    if (!sample.scan.isComplete || sample.scan.isAborted) {
      problems.push(`${where}: scan did not complete`);
    }
    if (!sample.consistency.rootCoversChildren) {
      problems.push(`${where}: root is smaller than its children`);
    }
    const walk = sample.consistency.fullWalk;
    if (walk && (!walk.countsMatch || walk.undersizedDirectories)) {
      problems.push(
        `${where}: full walk found ${walk.undersizedDirectories} undersized directories` +
          (walk.countsMatch ? '' : ' and mismatched counters'),
      );
    }
    for (const key of ['rankingAfterScan', 'rankingDuringRefresh', 'rankingAfterRefreshes']) {
      const ranking = sample.consistency[key];
      if (ranking && !ranking.matches) {
        problems.push(`${where}: ${key} differs from the brute-force reference`);
      }
    }
    for (const refresh of sample.refreshes) {
      if (refresh.parentDeltaMismatch || !refresh.isComplete) {
        problems.push(
          `${where}: refresh ${refresh.path} ` +
            (refresh.isComplete ? '' : 'did not complete; ') +
            `root changed ${refresh.rootDelta} bytes, target changed ${refresh.targetDelta}`,
        );
      }
    }
  }
  if (problems.length) {
    console.log('\n    ⚠ consistency problems:');
    for (const problem of problems) {
      console.log(`      ${problem}`);
    }
  }
}

function printTable(headers, rows, indent = 4) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => String(row[column] ?? '').length)),
  );
  const format = row =>
    ' '.repeat(indent) +
    row
      .map((cell, column) => {
        const text = String(cell ?? '');
        return LEFT_ALIGNED_COLUMNS.has(headers[column])
          ? text.padEnd(widths[column])
          : text.padStart(widths[column]);
      })
      .join('  ')
      .trimEnd();
  console.log(format(headers));
  console.log(' '.repeat(indent) + widths.map(width => '─'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(format(row));
  }
}

function environmentInfo() {
  const cpuInfo = cpus();
  return {
    node: process.version,
    platform: `${osType()} ${release()}`,
    arch: process.arch,
    cpuModel: cpuInfo[0]?.model ?? null,
    cpuCount: cpuInfo.length,
    totalMemoryBytes: totalmem(),
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null,
    git: gitInfo(),
  };
}

function gitInfo() {
  try {
    const git = (...args) =>
      execFileSync('git', args, {cwd: projectRoot, encoding: 'utf8'}).trim();
    return {
      commit: git('rev-parse', 'HEAD'),
      dirtyFiles: git('status', '--porcelain', '--untracked-files=normal')
        .split('\n')
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function rotate(items, count) {
  const offset = count % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return NaN;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function formatChange(values, baselineValues) {
  const value = median(values);
  const baseline = median(baselineValues);
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return '';
  }
  const change = ((value - baseline) / baseline) * 100;
  // With few samples, overlapping ranges mean the difference is within observed noise.
  const overlaps =
    Math.min(...values) <= Math.max(...baselineValues) &&
    Math.min(...baselineValues) <= Math.max(...values);
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%${overlaps ? ' ~' : ''}`;
}

function formatRange(values, formatter) {
  return `${formatter(Math.min(...values))}–${formatter(Math.max(...values))}`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) {
    return '-';
  }
  if (ms < 1) {
    return `${ms.toFixed(2)}ms`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatCount(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${bytes < 0 ? '-' : ''}${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function truncateMiddle(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  const keep = maxLength - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(-Math.floor(keep / 2))}`;
}

function displayPath(path) {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function list(value) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function positiveInteger(name, value, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    fail(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function validName(name) {
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
    fail(`Invalid name: ${name}`);
  }
  return name;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
