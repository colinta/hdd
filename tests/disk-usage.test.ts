import {describe, expect, it} from 'vitest';
import {parseSize} from './helpers/mock-filesystem.js';
import {
  createTestScanner,
  dedent,
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

// With fileMs: 10 and directoryMs: 100 the example scans on this timeline:
//   0    stat /, open /
//   100  read /; stat and open folder, folder2
//   200  read both; stat folder's files and folder3, open folder3
//   210  folder's files done
//   300  read folder3; stat file-1
//   310  done
const TIMED = {fileMs: 10, directoryMs: 100};

describe('scanning', () => {
  it('reports the size of every entry', async () => {
    const {fs, finish} = createTestScanner(EXAMPLE, TIMED);
    const report = await finish();

    expect(describeTree(report)).toBe(
      dedent(`
        /folder 2.40 GB
          filename-1 1.20 MB
          filename-2 2.40 GB
        /folder2 77.20 MB
          /folder3 77.20 MB
            file-1 77.20 MB
      `),
    );
    expect(report.size).toBe(fs.diskUsage());
    expect(report.files.get('folder')?.size).toBe(parseSize('1.2mb') + parseSize('2.4gb'));
    expect(report.isComplete).toBe(true);
    expect(report.isAborted).toBe(false);
    expect(report.errors).toEqual([]);
    expect(report.filesScanned).toBe(3);
    expect(report.directoriesScanned).toBe(4); // includes the root
    expect(report.pendingDirectories).toBe(0);
    expect(report.completedAt).toBe(310);
    expect(report.elapsedMs).toBe(310);
    expectConsistentReport(report);
  });

  it('indexes entries by path relative to the scan root', async () => {
    const {finish} = createTestScanner(EXAMPLE, {root: '/folder2'});
    const report = await finish();

    expect(report.rootPath).toBe('/folder2');
    expect([...report.files.keys()].sort()).toEqual(['.', 'folder3', 'folder3/file-1']);
    const file = report.files.get('folder3/file-1')!;
    expect(file.absolutePath).toBe('/folder2/folder3/file-1');
    expect(file.name).toBe('file-1');
    expectConsistentReport(report);
  });

  it('scans an empty directory', async () => {
    const {finish} = createTestScanner('');
    const report = await finish();

    expect(report.size).toBe(0);
    expect(report.children).toEqual([]);
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('scans a file root', async () => {
    const {finish} = createTestScanner('big.iso 4gb', {root: '/big.iso'});
    const report = await finish();

    expect(report.isDirectory).toBe(false);
    expect(report.size).toBe(4 * 1024 ** 3);
    expect(report.isComplete).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('reports a missing root', async () => {
    const {finish} = createTestScanner('', {root: '/missing'});
    const report = await finish();

    expect(report.errors).toEqual([
      expect.objectContaining({path: '.', code: 'ENOENT'}),
    ]);
    expect(report.error).not.toBeNull();
    expect(report.size).toBe(0);
    expect(report.isAborted).toBe(false);
  });

  it('counts allocated blocks and directory metadata', async () => {
    const {fs, finish} = createTestScanner('/dir 4kb\n  plain 1000');
    fs.writeFile('/dir/sparse', '1gb', {blocks: 16});
    const report = await finish();

    expect(report.files.get('dir/sparse')?.size).toBe(16 * 512);
    expect(report.files.get('dir')?.size).toBe(4096 + 1000 + 16 * 512);
    expect(report.size).toBe(fs.diskUsage());
  });

  it('counts symbolic links by their own size without following them', async () => {
    const {fs, finish} = createTestScanner('/target\n  big 1gb');
    fs.symlink('/link', '/target');
    const report = await finish();

    const link = report.files.get('link')!;
    expect(link.isDirectory).toBe(false);
    expect(link.size).toBe('/target'.length);
    expect(report.size).toBe(1024 ** 3 + '/target'.length);
    expect(fs.operationsFor({operation: 'opendir', path: '/link'})).toEqual([]);
  });

  it('exposes partial results while scanning', async () => {
    const {clock, report} = createTestScanner(EXAMPLE, TIMED);

    await clock.advanceTo(250);
    const progress = report();
    expect(describeTree(progress)).toBe(
      dedent(`
        /folder 2.40 GB
          filename-1 1.20 MB
          filename-2 2.40 GB
        /folder2 0 B (scanning)
          /folder3 0 B (scanning)
      `),
    );
    expect(progress.isComplete).toBe(false);
    expect(progress.files.get('folder')?.isComplete).toBe(true);
    expect(progress.pendingDirectories).toBe(1);
    expect(progress.completedAt).toBeNull();
    expect(progress.elapsedMs).toBe(250);
    expectConsistentReport(progress);
  });

  it('notifies subscribers with throttled progress and on completion', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    const notifiedAt: number[] = [];
    scanner.subscribe(() => notifiedAt.push(clock.now()));

    await clock.advanceTo(205);
    expect(notifiedAt.length).toBeGreaterThan(0);
    expect(scanner.getReport().isComplete).toBe(false);

    await finish();
    // Progress notifications are coalesced into 50ms windows; completion is immediate.
    expect(notifiedAt.at(-1)).toBe(310);
    expect(notifiedAt.length).toBeLessThanOrEqual(Math.ceil(310 / 50) + 1);
  });

  it('keeps scanning past unreadable directories', async () => {
    const {fs, finish} = createTestScanner(EXAMPLE, TIMED);
    fs.fail('/folder2/folder3', 'opendir', 'EACCES');
    const report = await finish();

    expect(report.isComplete).toBe(true);
    expect(report.errors).toEqual([
      expect.objectContaining({path: 'folder2/folder3', code: 'EACCES'}),
    ]);
    expect(report.files.get('folder2/folder3')?.error).toMatchObject({code: 'EACCES'});
    expect(report.size).toBe(parseSize('1.2mb') + parseSize('2.4gb'));
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('records directory read failures and closes the handle', async () => {
    const {fs, finish} = createTestScanner(EXAMPLE, TIMED);
    fs.fail('/folder', 'read', 'EIO');
    const report = await finish();

    expect(report.isComplete).toBe(true);
    expect(report.errors).toEqual([expect.objectContaining({path: 'folder', code: 'EIO'})]);
    expect(report.files.get('folder')?.children).toEqual([]);
    expect(report.size).toBe(parseSize('77.2mb'));
    expect(fs.openHandles).toBe(0);
  });

  it('records entries that cannot be stat-ed and leaves them out', async () => {
    const {fs, finish} = createTestScanner(EXAMPLE, TIMED);
    fs.fail('/folder/filename-2', 'lstat', 'EPERM');
    const report = await finish();

    expect(report.errors).toEqual([
      expect.objectContaining({path: 'folder/filename-2', code: 'EPERM'}),
    ]);
    expect(report.files.has('folder/filename-2')).toBe(false);
    expect(report.files.get('folder')?.isComplete).toBe(true);
    expect(report.files.get('folder')?.size).toBe(parseSize('1.2mb'));
    expectConsistentReport(report);
  });

  it('reports entries deleted between listing and stat', async () => {
    const {fs, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    const gate = fs.hold('/folder/filename-1', 'lstat');
    await clock.advanceTo(210);
    await gate.whenReached();
    fs.remove('/folder/filename-1');
    gate.release();

    const report = await finish();
    expect(report.errors).toEqual([
      expect.objectContaining({path: 'folder/filename-1', code: 'ENOENT'}),
    ]);
    expect(report.files.has('folder/filename-1')).toBe(false);
    expectConsistentReport(report);
  });

  it('limits concurrent filesystem operations', async () => {
    const files = Array.from({length: 50}, (_, index) => `file-${index} 1kb`).join('\n');
    const {fs, finish} = createTestScanner(files, TIMED);
    const report = await finish();

    expect(report.filesScanned).toBe(50);
    expect(report.size).toBe(50 * 1024);
    expect(fs.maxInFlight).toBe(8);
  });

  it('scans trees with more directories than it keeps open', async () => {
    const description = Array.from(
      {length: 300},
      (_, index) => `/dir-${index}\n  file 1kb`,
    ).join('\n');
    const {fs, finish} = createTestScanner(description, {...TIMED, readMs: 1});
    const report = await finish();

    expect(report.directoriesScanned).toBe(301);
    expect(report.size).toBe(300 * 1024);
    expect(fs.maxOpenHandles).toBeLessThanOrEqual(128);
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });
});

describe('refresh', () => {
  it('rescans the whole tree', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    fs.remove('/folder2/folder3');
    fs.writeFile('/folder/filename-1', '5mb');
    fs.add('/', '/new\n  thing 1kb');
    void scanner.refresh();
    const report = await finishScan(scanner, clock);

    expect(describeTree(report)).toBe(
      dedent(`
        /folder 2.40 GB
          filename-1 5.00 MB
          filename-2 2.40 GB
        /folder2 0 B
        /new 1.00 KB
          thing 1.00 KB
      `),
    );
    expect(report.size).toBe(fs.diskUsage());
    expect(report.files.has('folder2/folder3')).toBe(false);
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('rescans only the requested subtree', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();
    fs.clearOperations();

    fs.writeFile('/folder2/folder3/file-2', '1mb');
    fs.writeFile('/folder/filename-1', '9mb'); // outside the refresh; stays stale
    const refreshed = track(scanner.refresh('folder2'));
    const report = await finishScan(scanner, clock);

    expect(refreshed.isSettled).toBe(true);
    expect(fs.operations.length).toBeGreaterThan(0);
    expect(fs.operationsFor({within: '/folder2'})).toEqual(fs.operations);
    expect(report.files.get('folder2')?.size).toBe(parseSize('77.2mb') + parseSize('1mb'));
    expect(report.files.get('folder/filename-1')?.size).toBe(parseSize('1.2mb'));
    expect(report.size).toBe(
      parseSize('1.2mb') + parseSize('2.4gb') + parseSize('77.2mb') + parseSize('1mb'),
    );
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('accepts absolute paths and FileInfo.refresh()', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    fs.writeFile('/folder/filename-3', '1kb');
    void scanner.refresh('/folder');
    let report = await finishScan(scanner, clock);
    expect(report.files.has('folder/filename-3')).toBe(true);

    fs.writeFile('/folder2/folder3/file-2', '1kb');
    void report.files.get('folder2/folder3')!.refresh();
    report = await finishScan(scanner, clock);
    expect(report.files.has('folder2/folder3/file-2')).toBe(true);
    expect(report.size).toBe(fs.diskUsage());
    expectConsistentReport(report);
  });

  it('shows the subtree as scanning while it refreshes', async () => {
    const {scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    void scanner.refresh('folder2');
    await clock.advance(50);
    const progress = scanner.getReport();
    expect(progress.isComplete).toBe(false);
    expect(progress.files.get('folder2')?.isComplete).toBe(false);
    expect(progress.files.get('folder')?.isComplete).toBe(true);
    expectConsistentReport(progress);

    expect((await finishScan(scanner, clock)).isComplete).toBe(true);
  });

  it('removes a refreshed subtree that was deleted', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    fs.remove('/folder2');
    void scanner.refresh('folder2');
    const report = await finishScan(scanner, clock);

    expect(report.files.has('folder2')).toBe(false);
    expect(report.children.map(child => child.name)).toEqual(['folder']);
    expect(report.size).toBe(fs.diskUsage());
    expect(report.errors).toEqual([]);
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('handles a file replaced by a directory and vice versa', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    fs.remove('/folder/filename-1');
    fs.add('/folder', '/filename-1\n  inner 3kb');
    fs.remove('/folder2/folder3');
    fs.writeFile('/folder2/folder3', '2kb');

    void scanner.refresh('folder/filename-1');
    await finishScan(scanner, clock);
    void scanner.refresh('folder2/folder3');
    const report = await finishScan(scanner, clock);

    expect(report.files.get('folder/filename-1')?.isDirectory).toBe(true);
    expect(report.files.get('folder/filename-1/inner')?.size).toBe(3072);
    expect(report.files.get('folder2/folder3')?.isDirectory).toBe(false);
    expect(report.files.has('folder2/folder3/file-1')).toBe(false);
    expect(report.size).toBe(fs.diskUsage());
    expectConsistentReport(report);
  });

  it('restarts a subtree inside an active scan', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150); // folder and folder2 are being opened

    fs.writeFile('/folder2/late', '1mb');
    void scanner.refresh('folder2');
    const report = await finish();

    expect(report.files.has('folder2/late')).toBe(true);
    expect(report.size).toBe(fs.diskUsage());
    expect(report.isComplete).toBe(true);
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('settles on the latest of several rapid refreshes', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    fs.writeFile('/folder/extra', '1kb');
    fs.writeFile('/folder2/extra', '2kb');
    void scanner.refresh('folder');
    await clock.advance(20);
    void scanner.refresh('folder2');
    void scanner.refresh();
    const report = await finishScan(scanner, clock);

    expect(report.size).toBe(fs.diskUsage());
    expect(report.files.has('folder/extra')).toBe(true);
    expect(report.files.has('folder2/extra')).toBe(true);
    expect(report.isComplete).toBe(true);
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('discards results from a superseded refresh', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    // Hold the first refresh's directory listing, then refresh again after a change.
    const gate = fs.hold('/folder', 'opendir');
    void scanner.refresh('folder');
    await clock.advance(100);
    await gate.whenReached();

    fs.remove('/folder/filename-2');
    fs.writeFile('/folder/filename-3', '1kb');
    void scanner.refresh('folder');
    gate.release(); // the stale listing now completes (and sees the new entries)
    const report = await finishScan(scanner, clock);

    expect(report.files.get('folder')?.children.map(child => child.name).sort()).toEqual([
      'filename-1',
      'filename-3',
    ]);
    expect(report.size).toBe(fs.diskUsage());
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('reports refreshes outside the scan root', async () => {
    const {scanner, finish} = createTestScanner(EXAMPLE, {root: '/folder'});
    await finish();

    await scanner.refresh('/elsewhere');
    expect(scanner.getReport().errors).toEqual([
      expect.objectContaining({message: expect.stringMatching(/outside scan root/)}),
    ]);
  });

  it('reports refreshes of unknown paths', async () => {
    const {scanner, finish} = createTestScanner(EXAMPLE);
    await finish();

    await scanner.refresh('nope/nothing');
    expect(scanner.getReport().errors).toEqual([
      expect.objectContaining({message: expect.stringMatching(/not in the current scan/)}),
    ]);
  });
});

describe('abort', () => {
  it('keeps the partial results of an initial scan', async () => {
    const {fs, scanner, clock} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(250);
    const work = () => fs.operations.filter(record => record.operation !== 'close').length;
    const workBefore = work();

    scanner.abort();
    expect(scanner.getReport()).toMatchObject({isAborted: true, completedAt: 250});
    const report = await finishScan(scanner, clock);

    expect(report.isAborted).toBe(true);
    expect(report.isComplete).toBe(false);
    expect(report.files.get('folder')?.size).toBe(parseSize('1.2mb') + parseSize('2.4gb'));
    expect(report.files.has('folder2/folder3/file-1')).toBe(false);
    expect(work()).toBe(workBefore); // no new work was dispatched, only handles closed
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('restores the previous subtree when a refresh is aborted', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    const before = describeTree(await finish());

    fs.writeFile('/folder2/folder3/file-1', '1kb');
    void scanner.refresh('folder2');
    await clock.advance(150);
    scanner.abort();
    const report = await finishScan(scanner, clock);

    expect(report.isAborted).toBe(true);
    expect(describeTree(report)).toBe(before);
    expect(report.files.get('folder2')?.isComplete).toBe(true);
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('can rescan after aborting', async () => {
    const {fs, scanner, clock} = createTestScanner(EXAMPLE, TIMED);
    await clock.advance(150);
    scanner.abort();
    await finishScan(scanner, clock);

    void scanner.refresh();
    const report = await finishScan(scanner, clock);
    expect(report.isAborted).toBe(false);
    expect(report.isComplete).toBe(true);
    expect(report.size).toBe(fs.diskUsage());
    expectConsistentReport(report);
  });

  it('does nothing when idle', async () => {
    const {scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();
    scanner.abort();
    expect(scanner.getReport().isAborted).toBe(false);
    expect(scanner.getReport().isComplete).toBe(true);
  });
});

describe('ignore', () => {
  it('prunes a directory mid-scan and keeps scanning everything else', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150); // folder and folder2 are being opened

    scanner.ignore('folder');
    expect(scanner.getReport().files.has('folder')).toBe(false);
    const report = await finish();

    expect(report.isAborted).toBe(false);
    expect(report.isComplete).toBe(true);
    expect(report.size).toBe(fs.diskUsage('/folder2'));
    expect(report.files.has('folder2/folder3/file-1')).toBe(true);
    expect(fs.operationsFor({within: '/folder'}).filter(op => op.startedAt > 150)).toEqual(
      fs.operationsFor({within: '/folder', operation: 'close'}).filter(op => op.startedAt > 150),
    );
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('prunes a file mid-scan', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(205); // folder's file stats are in flight

    scanner.ignore('folder/filename-2');
    const report = await finish();

    expect(report.isAborted).toBe(false);
    expect(report.isComplete).toBe(true);
    expect(report.files.has('folder/filename-2')).toBe(false);
    expect(report.files.get('folder')?.isComplete).toBe(true);
    expect(report.size).toBe(parseSize('1.2mb') + parseSize('77.2mb'));
    expectConsistentReport(report);
  });

  it('skips an entry that was listed but not yet stat-ed', async () => {
    const files = Array.from({length: 50}, (_, index) => `file-${index} 1kb`).join('\n');
    const {fs, clock, scanner, finish} = createTestScanner(files, {fileMs: 10});
    await clock.advanceTo(5); // 8 stats in flight, the rest queued
    expect(fs.operationsFor({operation: 'lstat', path: '/file-40'})).toEqual([]);

    scanner.ignore('file-40');
    const report = await finish();

    expect(fs.operationsFor({operation: 'lstat', path: '/file-40'})).toEqual([]);
    expect(report.filesScanned).toBe(49);
    expect(report.size).toBe(49 * 1024);
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('never scans an entry ignored before it is discovered', async () => {
    const {fs, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    scanner.ignore('folder2/folder3');
    const report = await finish();

    expect(fs.operationsFor({within: '/folder2/folder3'})).toEqual([]);
    expect(report.files.get('folder2')?.children).toEqual([]);
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('releases the handle of a directory ignored mid-listing', async () => {
    const entries = Array.from({length: 20}, (_, index) => `  file-${index} 1kb`).join('\n');
    const {fs, clock, scanner, finish} = createTestScanner(`/big\n${entries}\nother 1kb`, {
      ...TIMED,
      readMs: 5,
    });
    await clock.advanceTo(222); // part way through reading /big
    expect(fs.openHandles).toBe(1);

    scanner.ignore('big');
    await clock.advance(5); // at most one in-flight read remains
    expect(fs.openHandles).toBe(0);
    const readsAfterIgnore = () =>
      fs.operationsFor({operation: 'read', path: '/big'}).filter(op => op.startedAt > 222);
    expect(readsAfterIgnore()).toEqual([]);

    const report = await finish();
    expect(readsAfterIgnore()).toEqual([]);
    expect(report.isComplete).toBe(true);
    expect(report.size).toBe(1024);
    expectConsistentReport(report);
  });

  it('keeps completed ancestors complete', async () => {
    const {clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(250); // folder is complete, folder2 is still scanning

    scanner.ignore('folder/filename-1');
    const progress = scanner.getReport();
    expect(progress.files.get('folder')?.isComplete).toBe(true);
    expect(progress.files.get('folder')?.size).toBe(parseSize('2.4gb'));
    expect(progress.files.get('folder2')?.isComplete).toBe(false);
    expect(progress.isComplete).toBe(false);
    expectConsistentReport(progress);

    expect((await finish()).isComplete).toBe(true);
  });

  it.each(['folder2', 'folder2/folder3'])(
    'finishes a refresh when %s (containing everything it scans) is ignored',
    async ignored => {
      const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
      await finish();

      const refreshed = track(scanner.refresh('folder2/folder3'));
      await clock.advance(50);
      scanner.ignore(ignored);
      const report = await finishScan(scanner, clock);

      expect(refreshed.isSettled).toBe(true);
      expect(report.isAborted).toBe(false);
      expect(report.isComplete).toBe(true);
      expect(report.files.has(ignored)).toBe(false);
      expect(report.size).toBe(
        fs.diskUsage() - fs.diskUsage(`/${ignored}`),
      );
      expect(fs.openHandles).toBe(0);
      expectConsistentReport(report);
    },
  );

  it('prunes a subtree that was restarted inside an active scan', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await clock.advanceTo(150);
    void scanner.refresh('folder2');
    await clock.advance(20);

    scanner.ignore('folder2');
    const report = await finish();

    expect(report.isAborted).toBe(false);
    expect(report.isComplete).toBe(true);
    expect(report.size).toBe(fs.diskUsage('/folder'));
    expect(fs.openHandles).toBe(0);
    expectConsistentReport(report);
  });

  it('drops warnings from ignored entries', async () => {
    const {fs, clock, scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    fs.fail('/folder2/folder3', 'opendir', 'EACCES');
    await clock.advanceTo(305);
    expect(scanner.getReport().errors).toHaveLength(1);

    scanner.ignore('folder2');
    const report = await finish();
    expect(report.errors).toEqual([]);
    expect(report.isComplete).toBe(true);
  });

  it('removes an ignored entry from the results', async () => {
    const {scanner, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    scanner.ignore('folder');
    const report = scanner.getReport();
    expect(report.files.has('folder')).toBe(false);
    expect(report.files.has('folder/filename-1')).toBe(false);
    expect(report.size).toBe(parseSize('77.2mb'));
    expect(report.isComplete).toBe(true);
    expectConsistentReport(report);
  });

  it('keeps ignored entries out of later scans', async () => {
    const {fs, scanner, clock, finish} = createTestScanner(EXAMPLE, TIMED);
    await finish();

    scanner.getReport().files.get('folder2/folder3')!.ignore();
    fs.clearOperations();
    void scanner.refresh();
    const report = await finishScan(scanner, clock);

    expect(report.files.has('folder2/folder3')).toBe(false);
    expect(fs.operationsFor({within: '/folder2/folder3'})).toEqual([]);
    expect(report.size).toBe(parseSize('1.2mb') + parseSize('2.4gb'));
    expectConsistentReport(report);
  });
});
