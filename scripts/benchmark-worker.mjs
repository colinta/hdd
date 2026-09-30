// Runs one benchmark sample in a fresh process. Started by scripts/benchmark.mjs; prints one
// `BENCH_RESULT <json>` line on stdout.
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const RESULT_PREFIX = 'BENCH_RESULT ';
const config = JSON.parse(process.argv[2]);
const {implementationDir, target, scenario, refreshCount, refreshRoot, verify, topCount} = config;

const {createDiskUsageScanner} = await import(
  pathToFileURL(join(resolve(implementationDir), 'disk-usage.js')).href
);

const ui = scenario === 'ui' ? createUiSimulator(topCount) : null;
const eventLoopDelay = monitorEventLoopDelay({resolution: 10});
eventLoopDelay.enable();

const cpuStart = process.cpuUsage();
const scanStart = performance.now();
const scanner = createDiskUsageScanner(target);
const unsubscribe = ui ? scanner.subscribe(() => ui.render(scanner.getReport())) : () => {};
const report = await scanner.wait();
const wallMs = performance.now() - scanStart;
const cpu = process.cpuUsage(cpuStart);
eventLoopDelay.disable();

const scan = {
  wallMs,
  cpuUserMs: cpu.user / 1000,
  cpuSystemMs: cpu.system / 1000,
  entries: report.entriesScanned,
  files: report.filesScanned,
  directories: report.directoriesScanned,
  size: report.size,
  errors: report.errors.length,
  isComplete: report.isComplete,
  isAborted: report.isAborted,
  eventLoopDelay: summarizeDelay(eventLoopDelay),
  ui: ui?.summary() ?? null,
  memory: scanner.getMemoryUsage(),
};

// Take a stable heap measurement before refreshes add rollback trees and views.
globalThis.gc?.();
const heapAfterScan = process.memoryUsage();
const consistency = checkConsistency(scanner.getReport(), verify);
if (verify) {
  consistency.rankingAfterScan = checkRanking(scanner.getReport(), topCount);
}
const refreshes = await runRefreshes();
if (verify) {
  consistency.rankingAfterRefreshes = checkRanking(scanner.getReport(), topCount);
}
unsubscribe();

const resourceUsage = process.resourceUsage();
process.stdout.write(
  RESULT_PREFIX +
    JSON.stringify({
      scan,
      refreshes,
      consistency,
      process: {
        // resourceUsage reports maxRSS in kilobytes.
        maxRssBytes: resourceUsage.maxRSS * 1024,
        heapUsedAfterScanBytes: heapAfterScan.heapUsed,
        externalAfterScanBytes: heapAfterScan.external,
        arrayBuffersAfterScanBytes: heapAfterScan.arrayBuffers,
        uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null,
      },
    }) +
    '\n',
);

async function runRefreshes() {
  const current = scanner.getReport();
  const paths = [];
  const directoriesOf = info =>
    info.children
      .filter(child => child.isDirectory && !child.aliasOf)
      .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  // Skip single-directory chains (like ~/src/github.com) so refreshes cover sibling subtrees.
  let branch = current;
  let directories = directoriesOf(branch);
  while (directories.length === 1) {
    branch = directories[0];
    directories = directoriesOf(branch);
  }
  for (const child of directories.slice(0, refreshCount)) {
    paths.push({kind: 'subtree', path: child.path});
  }
  // The largest non-redundant directory is usually deep, exercising longer ancestor chains.
  const deep = current.largest(1).directories[0]?.[1];
  if (refreshCount > 0 && deep && !paths.some(({path}) => path === deep.path)) {
    paths.push({kind: 'largest-candidate', path: deep.path});
  }
  if (refreshRoot) {
    paths.push({kind: 'root', path: '.'});
  }

  const results = [];
  for (const {kind, path} of paths) {
    const before = scanner.getReport();
    const targetBefore = path === '.' ? before : before.files.get(path);
    if (!targetBefore) {
      continue;
    }
    const rootSizeBefore = before.size;
    const targetSizeBefore = targetBefore.size;
    const depth = path === '.' ? 0 : path.split('/').length;

    // While a refresh runs, the previous subtree is kept aside for rollback. Check once, midway,
    // that rankings only include the visible tree.
    let stopMidRefreshCheck = () => {};
    if (verify && !consistency.rankingDuringRefresh && path !== '.') {
      const startedAt = performance.now();
      stopMidRefreshCheck = scanner.subscribe(() => {
        if (consistency.rankingDuringRefresh || performance.now() - startedAt < 200) {
          return;
        }
        const report = scanner.getReport();
        if (report.isComplete) {
          return;
        }
        // A different count bypasses the ranking cache, so the result reflects this instant.
        consistency.rankingDuringRefresh = {path, ...checkRanking(report, topCount + 1)};
      });
    }

    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    await scanner.refresh(path);
    stopMidRefreshCheck();
    const refreshMs = performance.now() - start;
    const refreshCpu = process.cpuUsage(cpuBefore);

    const after = scanner.getReport();
    const targetAfter = path === '.' ? after : after.files.get(path);
    const rootDelta = after.size - rootSizeBefore;
    const targetDelta = (targetAfter?.size ?? 0) - targetSizeBefore;
    results.push({
      kind,
      path,
      depth,
      wallMs: refreshMs,
      cpuUserMs: refreshCpu.user / 1000,
      cpuSystemMs: refreshCpu.system / 1000,
      entries: targetAfter ? countSubtree(targetAfter) : 0,
      targetSizeBefore,
      targetSizeAfter: targetAfter?.size ?? 0,
      rootDelta,
      targetDelta,
      // For a subtree refresh, the root must change by exactly the subtree's change.
      parentDeltaMismatch: path === '.' ? 0 : rootDelta - targetDelta,
      isComplete: after.isComplete,
      errors: after.errors.length,
    });
  }
  return results;
}

function countSubtree(info) {
  let count = 0;
  const stack = [info];
  while (stack.length) {
    const current = stack.pop();
    count += 1;
    if (current.isDirectory) {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return count;
}

function checkConsistency(current, fullWalk) {
  const childTotal = current.children.reduce((total, child) => total + child.size, 0);
  const result = {
    rootCoversChildren: current.size >= childTotal,
    fullWalk: null,
  };
  if (!fullWalk) {
    return result;
  }

  let entries = 0;
  let directories = 0;
  let undersizedDirectories = 0;
  const stack = [current];
  while (stack.length) {
    const info = stack.pop();
    entries += 1;
    if (!info.isDirectory) {
      continue;
    }
    directories += 1;
    let total = 0;
    for (const child of info.children) {
      total += child.size;
      stack.push(child);
    }
    if (info.size < total) {
      undersizedDirectories += 1;
    }
  }
  result.fullWalk = {
    entries,
    directories,
    undersizedDirectories,
    countsMatch:
      entries === current.entriesScanned && directories === current.directoriesScanned,
  };
  return result;
}

// A brute-force reference for ProgressReport.largest: walks every entry through the public views.
// Directories are selected by their size beyond their largest child directory; files by size.
function checkRanking(report, count) {
  const directories = [];
  const files = [];
  const stack = [...report.children];
  while (stack.length) {
    const info = stack.pop();
    if (!info.isDirectory) {
      files.push({path: info.path, size: info.size, selectionSize: info.size});
      continue;
    }
    if (info.aliasOf) {
      continue;
    }
    let largestChild = 0;
    for (const child of info.children) {
      if (child.isDirectory && child.size > largestChild) {
        largestChild = child.size;
      }
      stack.push(child);
    }
    const selectionSize = Math.max(0, info.size - largestChild);
    if (selectionSize > 0) {
      directories.push({path: info.path, size: info.size, selectionSize});
    }
  }
  const bySelection = (a, b) =>
    b.selectionSize - a.selectionSize || b.size - a.size || a.path.localeCompare(b.path);
  const expectedDirectories = directories
    .sort(bySelection)
    .slice(0, count)
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .map(entry => entry.path);
  const expectedFiles = files.sort(bySelection).slice(0, count).map(entry => entry.path);

  const actual = report.largest(count);
  const actualDirectories = actual.directories.map(([path]) => path);
  const actualFiles = actual.files.map(([path]) => path);
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const matches = same(actualDirectories, expectedDirectories) && same(actualFiles, expectedFiles);
  return matches
    ? {matches}
    : {matches, expectedDirectories, actualDirectories, expectedFiles, actualFiles};
}

// Approximates the scanner work App.tsx does for each progress notification. Rendering itself is
// intentionally excluded; this measures report, ranking, and root-row preparation cost.
function createUiSimulator(count) {
  let renders = 0;
  let totalMs = 0;
  let maxMs = 0;
  let checksum = 0;

  return {
    render(report) {
      const start = performance.now();
      const {directories, files} = report.largest(count);
      for (const [, info] of directories) checksum += info.size + info.path.length;
      for (const [, info] of files) checksum += info.size + info.path.length;
      const rows = [...report.children]
        .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
        .slice(0, 500);
      for (const row of rows) {
        checksum += row.size + row.name.length + (row.isDirectory ? row.childCount : 0);
      }
      checksum += report.entriesScanned + report.errors.length;
      const elapsed = performance.now() - start;
      renders += 1;
      totalMs += elapsed;
      maxMs = Math.max(maxMs, elapsed);
    },
    summary() {
      return {renders, totalMs, maxMs, checksum};
    },
  };
}

function summarizeDelay(histogram) {
  const toMs = value => (Number.isFinite(value) ? value / 1e6 : 0);
  return {
    meanMs: toMs(histogram.mean),
    p50Ms: toMs(histogram.percentile(50)),
    p99Ms: toMs(histogram.percentile(99)),
    maxMs: toMs(histogram.max),
  };
}
