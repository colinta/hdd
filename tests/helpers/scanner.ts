import {expect} from 'vitest';
import {
  createDiskUsageScanner,
  formatBytes,
  type DiskUsageScanner,
  type FileInfo,
  type ProgressReport,
} from '../../disk-usage.js';
import {ManualClock} from './manual-clock.js';
import {createMockFileSystem, type MockFileSystem, type MockFileSystemOptions} from './mock-filesystem.js';

export interface TestScanner {
  fs: MockFileSystem;
  clock: ManualClock;
  scanner: DiskUsageScanner;
  report(): ProgressReport;
  /** Runs simulated time until the current scan settles. Fails if it cannot (paused, gated). */
  finish(): Promise<ProgressReport>;
}

/** Creates a mock filesystem and starts a scanner on it (scanning starts immediately). */
export function createTestScanner(
  description: string,
  options: MockFileSystemOptions & {root?: string} = {},
): TestScanner {
  const clock = options.clock ?? new ManualClock();
  const fs = createMockFileSystem(description, {...options, clock});
  const scanner = createDiskUsageScanner(options.root ?? '/', {fileSystem: fs, clock});
  return {
    fs,
    clock,
    scanner,
    report: () => scanner.getReport(),
    finish: () => finishScan(scanner, clock),
  };
}

export async function finishScan(
  scanner: DiskUsageScanner,
  clock: ManualClock,
): Promise<ProgressReport> {
  const tracked = track(scanner.wait());
  await clock.runAll();
  await clock.flush();
  if (!tracked.isSettled) {
    throw new Error(
      'The scan is still running after every timer fired (is it paused or held by a gate?)',
    );
  }
  return tracked.promise;
}

export interface TrackedPromise<T> {
  promise: Promise<T>;
  readonly isSettled: boolean;
}

/** Wraps a promise so tests can check synchronously whether it has settled. */
export function track<T>(promise: Promise<T>): TrackedPromise<T> {
  let isSettled = false;
  const wrapped = promise.finally(() => {
    isSettled = true;
  });
  // Avoid unhandled rejections for promises a test never awaits.
  wrapped.catch(() => {});
  return {
    promise: wrapped,
    get isSettled() {
      return isSettled;
    },
  };
}

/**
 * Renders the scanned tree in the fixture style, sorted by name:
 *
 *   /folder 2.40 GB
 *     filename-1 1.20 MB
 *
 * Incomplete directories are marked `(scanning)` and failed entries `(error: CODE)`.
 */
export function describeTree(info: FileInfo): string {
  const lines: string[] = [];
  const visit = (node: FileInfo, depth: number): void => {
    const children = [...node.children].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const markers = [
        child.isDirectory && !child.isComplete ? '(scanning)' : null,
        child.error ? `(error: ${(child.error as {code?: string}).code ?? child.error.message})` : null,
      ].filter(Boolean);
      lines.push(
        `${'  '.repeat(depth)}${child.isDirectory ? '/' : ''}${child.name} ${formatBytes(child.size)}` +
          (markers.length ? ` ${markers.join(' ')}` : ''),
      );
      if (child.isDirectory) {
        visit(child, depth + 1);
      }
    }
  };
  visit(info, 0);
  return lines.join('\n');
}

/** Strips common indentation from a template literal so expectations can be indented. */
export function dedent(text: string): string {
  const lines = text.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(
    ...lines.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length),
  );
  return lines.map(line => line.slice(indent).trimEnd()).join('\n');
}

/**
 * Checks the invariants tying the tree, the path index, and the counters together: every node
 * in the tree is indexed under its own path, nothing else is indexed, the counters match, and
 * each directory is at least as large as its children combined.
 */
export function expectConsistentReport(report: ProgressReport): void {
  const reachable = new Map<string, FileInfo>();
  const visit = (node: FileInfo, key: string): void => {
    expect(reachable.has(key), `duplicate tree entry for ${key}`).toBe(false);
    reachable.set(key, node);
    let childTotal = 0;
    for (const child of node.children) {
      expect(child.path.startsWith(key === '.' ? '' : `${key}/`), `${child.path} under ${key}`).toBe(
        true,
      );
      childTotal += child.size;
      visit(child, child.path);
    }
    expect(node.size, `size of ${key}`).toBeGreaterThanOrEqual(childTotal);
  };
  visit(report, '.');

  expect([...report.files.keys()].sort()).toEqual([...reachable.keys()].sort());
  for (const [key, node] of reachable) {
    // The report is a snapshot of the root, so only descendants can be compared by identity.
    if (key !== '.') {
      expect(report.files.get(key), `index entry for ${key}`).toBe(node);
    }
  }

  const directories = [...reachable.values()].filter(node => node.isDirectory).length;
  expect(report.directoriesScanned).toBe(directories);
  expect(report.filesScanned).toBe(reachable.size - directories);
  expect(report.entriesScanned).toBe(reachable.size);
}
