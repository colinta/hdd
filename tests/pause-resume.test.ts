import {describe, expect, it} from 'vitest';
import type {MockFileSystem} from './helpers/mock-filesystem.js';
import {
  createTestScanner,
  describeTree,
  expectConsistentReport,
  finishScan,
  track,
} from './helpers/scanner.js';

const EXAMPLE = `
  /folder
    filename-1 1.2mb
    filename-2 2.4gb
  /folder2
    /folder3
      file-1  77.2mb
`;

// Timeline (see disk-usage.test.ts): directory opens finish at 100, 200, and 300;
// file stats at 210 and 310.
const TIMED = {fileMs: 10, directoryMs: 100};

async function uninterruptedTree(description = EXAMPLE, options = TIMED): Promise<string> {
  return describeTree(await createTestScanner(description, options).finish());
}

function expectNoRepeatedWork(fs: MockFileSystem): void {
  for (const operation of ['lstat', 'opendir'] as const) {
    const paths = fs.operationsFor({operation}).map(record => record.path);
    expect(paths, `${operation} paths`).toEqual([...new Set(paths)]);
  }
}

describe('pause and resume', () => {
  it('stops dispatching work and resumes where it left off', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150); // folder and folder2 are being opened

    const paused = track(scanner.pause());
    expect(scanner.getReport().isPaused).toBe(true);
    await clock.flush();
    expect(paused.isSettled).toBe(false); // waits for in-flight operations

    await clock.advanceTo(200);
    expect(paused.isSettled).toBe(true);
    const operations = fs.operations.length;
    expect(fs.openHandles).toBe(2); // directories stay open while paused

    await clock.advance(10_000);
    const progress = scanner.getReport();
    expect(fs.operations.length).toBe(operations);
    expect(progress.isPaused).toBe(true);
    expect(progress.isComplete).toBe(false);
    expect(progress.pendingDirectories).toBe(2);
    expectConsistentReport(progress);

    scanner.resume();
    expect(scanner.getReport().isPaused).toBe(false);
    const report = await finish();

    expect(report.isComplete).toBe(true);
    expect(report.size).toBe(fs.diskUsage());
    expect(describeTree(report)).toBe(await uninterruptedTree());
    expectNoRepeatedWork(fs);
    expect(fs.openHandles).toBe(0);
  });

  // Pause at every interesting boundary: stats, directory opens, reads, and completion.
  it.each([0, 1, 50, 100, 101, 150, 200, 205, 210, 250, 299])(
    'pausing at %ims produces the same result without repeating work',
    async pauseAt => {
      const expected = await uninterruptedTree();
      const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
      await clock.advanceTo(pauseAt);

      const paused = track(scanner.pause());
      await clock.advance(100); // lets in-flight work finish
      expect(paused.isSettled).toBe(true);
      expect(fs.inFlight).toBe(0);

      const operations = fs.operations.length;
      await clock.advance(1_000);
      expect(fs.operations.length).toBe(operations);
      expect(scanner.getReport().isComplete).toBe(false);
      expectConsistentReport(scanner.getReport());

      scanner.resume();
      const report = await finish();
      expect(describeTree(report)).toBe(expected);
      expect(report.isComplete).toBe(true);
      expectNoRepeatedWork(fs);
      expect(fs.openHandles).toBe(0);
    },
  );

  it('completes while paused when only in-flight work remains', async () => {
    const {clock, scanner} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(305); // the last file stat is in flight

    const paused = track(scanner.pause());
    const waiting = track(scanner.wait());
    await clock.advance(5);

    expect(paused.isSettled).toBe(true);
    expect(waiting.isSettled).toBe(true);
    const report = scanner.getReport();
    expect(report.isComplete).toBe(true);
    expect(report.isPaused).toBe(false);
  });

  it('pauses between reads of a directory', async () => {
    const description = Array.from({length: 20}, (_, index) => `file-${index} 1kb`).join('\n');
    const {fs, clock, scanner, finish} = createTestScanner(`/big\n${description.replace(/^/gm, '  ')}`, {
      ...TIMED,
      readMs: 5,
    });
    await clock.advanceTo(222); // part way through reading /big

    const paused = track(scanner.pause());
    await clock.advance(50);
    expect(paused.isSettled).toBe(true);
    const scannedWhilePaused = scanner.getReport().filesScanned;
    expect(scannedWhilePaused).toBeGreaterThan(0);
    expect(scannedWhilePaused).toBeLessThan(20);
    expect(fs.openHandles).toBe(1);

    await clock.advance(1_000);
    expect(scanner.getReport().filesScanned).toBe(scannedWhilePaused);

    scanner.resume();
    const report = await finish();
    expect(report.filesScanned).toBe(20);
    expect(report.size).toBe(20 * 1024);
    expect(fs.operationsFor({operation: 'opendir', path: '/big'})).toHaveLength(1);
    expect(fs.openHandles).toBe(0);
  });

  it('survives repeated pause/resume cycles', async () => {
    const expected = await uninterruptedTree();
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);

    for (let cycle = 0; cycle < 30; cycle++) {
      void scanner.pause();
      await clock.advance(7);
      scanner.resume();
      await clock.advance(13);
    }

    const report = await finish();
    expect(describeTree(report)).toBe(expected);
    expectNoRepeatedWork(fs);
  });

  it('keeps wait() pending while paused', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);
    await Promise.all([scanner.pause(), clock.advance(100)]);

    const waiting = track(scanner.wait());
    await clock.runAll();
    expect(waiting.isSettled).toBe(false);
    await expect(finish()).rejects.toThrow(/paused/);

    scanner.resume();
    await clock.runAll();
    expect(waiting.isSettled).toBe(true);
    expect((await waiting.promise).isComplete).toBe(true);
  });

  it('resolves pause() when resumed before in-flight work finishes', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);

    const paused = track(scanner.pause());
    scanner.resume();
    await clock.flush();
    expect(paused.isSettled).toBe(true);
    expect((await finish()).isComplete).toBe(true);
  });

  it('keeps the scan paused when refreshed', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);
    await Promise.all([scanner.pause(), clock.advance(100)]);

    fs.writeFile('/folder/late', '1mb');
    fs.clearOperations();
    const refreshed = track(scanner.refresh());
    await clock.advance(1_000);

    expect(scanner.getReport().isPaused).toBe(true);
    expect(refreshed.isSettled).toBe(false);
    // The superseded scan only closes its directories; the new one has not started any work.
    expect(fs.operations.map(record => record.operation)).toEqual(['close', 'close']);

    scanner.resume();
    const report = await finish();
    expect(refreshed.isSettled).toBe(true);
    expect(report.files.has('folder/late')).toBe(true);
    expect(report.size).toBe(fs.diskUsage());
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('keeps the scan paused when a subtree of the active scan is refreshed', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(250);
    await Promise.all([scanner.pause(), clock.advance(100)]);

    fs.writeFile('/folder/late', '1mb');
    fs.clearOperations();
    void scanner.refresh('folder');
    await clock.advance(1_000);

    const progress = scanner.getReport();
    expect(progress.isPaused).toBe(true);
    expect(progress.files.get('folder')?.isComplete).toBe(false);
    expect(fs.operations).toEqual([]);
    expectConsistentReport(progress);

    scanner.resume();
    const report = await finish();
    expect(report.files.has('folder/late')).toBe(true);
    expect(report.size).toBe(fs.diskUsage());
    expectConsistentReport(report);
  });

  it('pauses a subtree refresh without losing the previous results on abort', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    const before = describeTree(await finish());

    fs.writeFile('/folder2/folder3/file-1', '1kb');
    void scanner.refresh('folder2');
    await clock.advance(150);
    await Promise.all([scanner.pause(), clock.advance(100)]);
    expect(scanner.getReport().isPaused).toBe(true);

    scanner.abort();
    const report = await finishScan(scanner, clock);
    expect(describeTree(report)).toBe(before);
    expect(report.isPaused).toBe(false);
  });

  it('aborts a paused scan and releases its directories', async () => {
    const {fs, clock, scanner} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);
    await Promise.all([scanner.pause(), clock.advance(100)]);
    expect(fs.openHandles).toBeGreaterThan(0);

    scanner.abort();
    const report = await finishScan(scanner, clock);
    expect(report.isAborted).toBe(true);
    expect(report.isPaused).toBe(false);
    expect(fs.openHandles).toBe(0);

    // A later rescan runs normally.
    void scanner.refresh();
    const rescanned = await finishScan(scanner, clock);
    expect(rescanned.isComplete).toBe(true);
    expect(rescanned.size).toBe(fs.diskUsage());
  });

  it('stays paused when an entry is ignored', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(250);
    await Promise.all([scanner.pause(), clock.advance(100)]);
    const operations = fs.operations.length;

    scanner.ignore('folder');
    await clock.advance(1_000);
    expect(scanner.getReport().isPaused).toBe(true);
    expect(scanner.getReport().files.has('folder')).toBe(false);
    expect(fs.operations.length).toBe(operations);

    scanner.resume();
    const report = await finish();
    expect(report.isComplete).toBe(true);
    expect(report.isAborted).toBe(false);
    expect(report.size).toBe(fs.diskUsage('/folder2'));
    expectConsistentReport(report);
  });

  it('releases the handle of a directory ignored while its next read is queued', async () => {
    const entries = Array.from({length: 20}, (_, index) => `  file-${index} 1kb`).join('\n');
    const {fs, clock, scanner, finish} = createTestScanner(`/big\n${entries}\n/slow\n  a 1kb`, {
      ...TIMED,
      readMs: 5,
    });
    fs.setDelay('/slow', 'opendir', 1_000); // keeps the scan running after /big
    await clock.advanceTo(222); // part way through reading /big
    void scanner.pause(); // the slow opendir stays in flight, so don't wait for it
    await clock.advance(5);
    expect(fs.openHandles).toBe(1); // /big stays open, its next read queued

    scanner.ignore('big');
    scanner.resume();
    await clock.flush();
    expect(fs.openHandles).toBe(0); // released without waiting for the scan to finish

    const report = await finish();
    expect(report.isComplete).toBe(true);
    expect(report.size).toBe(1024);
    expectConsistentReport(report);
  });

  it('does nothing when idle', async () => {
    const {scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    await scanner.pause();
    expect(scanner.getReport().isPaused).toBe(false);

    // A later refresh is not affected.
    void scanner.refresh();
    expect((await finish()).isComplete).toBe(true);

    scanner.resume(); // resuming without a pause is harmless
    expect(scanner.getReport().isPaused).toBe(false);
  });

  it('notifies subscribers when pausing and resuming', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);
    const states: boolean[] = [];
    scanner.subscribe(() => states.push(scanner.getReport().isPaused));

    void scanner.pause();
    expect(states).toEqual([true]);
    scanner.resume();
    expect(states).toEqual([true, false]);
    await finish();
  });

  it('includes paused time in the elapsed time', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);
    await Promise.all([scanner.pause(), clock.advance(50)]);
    await clock.advance(1_000);
    expect(scanner.getReport().elapsedMs).toBe(1_200);

    scanner.resume();
    const report = await finish();
    // The remaining work (from 200 to 310) runs after the 1000ms pause.
    expect(report.elapsedMs).toBe(1_310);
  });
});
