import {describe, expect, it} from 'vitest';
import {createDiskUsageScanner} from '../disk-usage.js';
import {multiScanner, prefixPath, rootPrefix} from '../multi-scanner.js';
import {ManualClock} from './helpers/manual-clock.js';
import {createMockFileSystem, parseSize} from './helpers/mock-filesystem.js';

const ONE = `
  /one
    /big
      file-a 3mb
    small 1mb
`;

const TWO = `
  /two
    /medium
      file-b 2mb
    tiny 10kb
`;

function createScanners(clock: ManualClock, ...descriptions: string[]) {
  const roots = descriptions.map(description => /\/(\w+)/.exec(description)![1]);
  return multiScanner(
    descriptions.map((description, index) =>
      createDiskUsageScanner(`/${roots[index]}`, {
        fileSystem: createMockFileSystem(description, {clock}),
        clock,
      }),
    ),
  );
}

async function finish(clock: ManualClock, scanner: ReturnType<typeof multiScanner>) {
  const done = scanner.wait();
  await clock.runAll();
  await clock.flush();
  return done;
}

describe('prefixes', () => {
  it('only prefixes when several folders are scanned', () => {
    expect(rootPrefix(0, 1)).toBe('');
    expect(rootPrefix(0, 2)).toBe('1/');
    expect(rootPrefix(1, 2)).toBe('2/');
  });

  it('prefixes path keys', () => {
    expect(prefixPath('', 'a/b')).toBe('a/b');
    expect(prefixPath('2/', 'a/b')).toBe('2/a/b');
    expect(prefixPath('2/', '.')).toBe('2/');
  });
});

describe('combined reports', () => {
  it('sums every folder', async () => {
    const clock = new ManualClock();
    const scanner = createScanners(clock, ONE, TWO);
    const report = await finish(clock, scanner);

    expect(report.isMultiple).toBe(true);
    expect(report.isComplete).toBe(true);
    expect(report.isAborted).toBe(false);
    expect(report.roots.map(root => root.rootPath)).toEqual(['/one', '/two']);
    expect(report.size).toBe(report.roots[0].size + report.roots[1].size);
    expect(report.filesScanned).toBe(4);
    expect(report.directoriesScanned).toBe(4);
    expect(report.entriesScanned).toBe(8);
  });

  it('feathers top-level entries together, prefixed by their folder', async () => {
    const clock = new ManualClock();
    const scanner = createScanners(clock, ONE, TWO);
    const report = await finish(clock, scanner);

    const children = report.children
      .sort((a, b) => b.info.size - a.info.size)
      .map(({prefix, info}) => prefix + info.name);
    expect(children).toEqual(['1/big', '2/medium', '1/small', '2/tiny']);
  });

  it('merges the largest entries with prefixed paths', async () => {
    const clock = new ManualClock();
    const scanner = createScanners(clock, ONE, TWO);
    const report = await finish(clock, scanner);

    const {directories, files} = report.largest(3);
    expect(files.map(([path]) => path)).toEqual(['1/big/file-a', '2/medium/file-b', '1/small']);
    expect(directories.map(([path]) => path)).toEqual(['1/big', '2/medium']);
    expect(files[0][1].size).toBeGreaterThanOrEqual(parseSize('3mb'));
  });

  it('leaves a single folder unprefixed', async () => {
    const clock = new ManualClock();
    const scanner = createScanners(clock, ONE);
    const report = await finish(clock, scanner);

    expect(report.isMultiple).toBe(false);
    expect(report.children.map(({prefix, info}) => prefix + info.name).sort()).toEqual([
      'big',
      'small',
    ]);
    expect(report.largest(1).files.map(([path]) => path)).toEqual(['big/file-a']);
  });

  it('aborts every folder', async () => {
    const clock = new ManualClock();
    const scanner = createScanners(clock, ONE, TWO);
    scanner.abort();
    const report = await finish(clock, scanner);

    expect(report.isAborted).toBe(true);
    expect(report.isComplete).toBe(false);
  });
});
