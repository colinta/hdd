import {describe, expect, it} from 'vitest';
import {ManualClock} from './helpers/manual-clock.js';
import {
  createMockFileSystem,
  FileSystemDescriptionError,
  parseSize,
  type MockFileSystem,
} from './helpers/mock-filesystem.js';
import {track} from './helpers/scanner.js';

async function list(fs: MockFileSystem, path: string): Promise<string[]> {
  const directory = await fs.opendir(path);
  const names: string[] = [];
  for (let entry = await directory.read(); entry; entry = await directory.read()) {
    names.push(entry.name);
  }
  await directory.close();
  return names;
}

describe('parseSize', () => {
  it.each([
    ['0', 0],
    ['12', 12],
    ['12b', 12],
    ['1kb', 1024],
    ['1K', 1024],
    ['1.5KiB', 1536],
    ['1.2mb', Math.round(1.2 * 1024 ** 2)],
    ['2.4GB', Math.round(2.4 * 1024 ** 3)],
    ['1tb', 1024 ** 4],
    ['1pb', 1024 ** 5],
    ['.5kb', 512],
  ])('parses %s', (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it('rounds to whole bytes and passes numbers through', () => {
    expect(parseSize('1.0001kb')).toBe(1024);
    expect(parseSize(1234.4)).toBe(1234);
  });

  it.each(['', 'mb', '1xb', '-1kb', '1 2', '1.2.3mb'])('rejects %j', input => {
    expect(() => parseSize(input)).toThrow(/Invalid size/);
  });
});

describe('text descriptions', () => {
  it('builds the described tree', async () => {
    const fs = createMockFileSystem(`
      /folder
        filename-1 1.2mb
        filename-2 2.4gb
      /folder2
        /folder3
          file-1  77.2mb
    `);

    expect(await list(fs, '/')).toEqual(['folder', 'folder2']);
    expect(await list(fs, '/folder')).toEqual(['filename-1', 'filename-2']);
    expect(await list(fs, '/folder2')).toEqual(['folder3']);
    expect(await list(fs, '/folder2/folder3')).toEqual(['file-1']);
    expect((await fs.lstat('/folder/filename-1')).size).toBe(parseSize('1.2mb'));
    expect((await fs.lstat('/folder2/folder3/file-1')).size).toBe(parseSize('77.2mb'));
    expect((await fs.lstat('/folder')).isDirectory()).toBe(true);
    expect((await fs.lstat('/folder/filename-2')).isDirectory()).toBe(false);
    expect(fs.diskUsage()).toBe(parseSize('1.2mb') + parseSize('2.4gb') + parseSize('77.2mb'));
  });

  it('accepts names with spaces, trailing-slash directories, and directory sizes', async () => {
    const fs = createMockFileSystem(`
      My Documents/ 4kb
        annual report.pdf 3mb
      /empty
    `);

    expect(await list(fs, '/')).toEqual(['My Documents', 'empty']);
    expect((await fs.lstat('/My Documents')).size).toBe(4096);
    expect((await fs.lstat('/My Documents/annual report.pdf')).size).toBe(3 * 1024 ** 2);
    expect(await list(fs, '/empty')).toEqual([]);
    expect(fs.diskUsage('/My Documents')).toBe(4096 + 3 * 1024 ** 2);
  });

  it('treats an empty description as an empty root', async () => {
    expect(await list(createMockFileSystem(), '/')).toEqual([]);
    expect(await list(createMockFileSystem('\n   \n'), '/')).toEqual([]);
  });

  it('dedents back to earlier levels', async () => {
    const fs = createMockFileSystem(`
      /a
        /b
          deep 1
        shallow 2
      top 3
    `);
    expect(await list(fs, '/')).toEqual(['a', 'top']);
    expect(await list(fs, '/a')).toEqual(['b', 'shallow']);
    expect(await list(fs, '/a/b')).toEqual(['deep']);
  });

  it.each([
    ['a file without a size', '/dir\n  notes', 2, /needs a size/],
    ['entries beneath a file', 'file 1kb\n  child 1kb', 2, /beneath a file/],
    ['duplicate entries', '/dir\n  a 1\n  a 2', 3, /duplicate entry "a"/],
    ['inconsistent indentation', '/dir\n    a 1\n  b 2', 3, /inconsistent indentation/],
    ['tabs', '/dir\n\ta 1', 2, /tabs/],
    ['path separators in names', '/a/b', 1, /invalid name/],
    ['dot entries', '/..', 1, /invalid name/],
  ])('rejects %s with the line number', (_, description, line, message) => {
    let caught: unknown;
    try {
      createMockFileSystem(description);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileSystemDescriptionError);
    expect((caught as FileSystemDescriptionError).line).toBe(line);
    expect((caught as Error).message).toMatch(message);
  });
});

describe('MockFileSystem', () => {
  it('reports node-style errors', async () => {
    const fs = createMockFileSystem('file 1kb');

    await expect(fs.lstat('/missing')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(fs.lstat('/file/child')).rejects.toMatchObject({code: 'ENOTDIR'});
    await expect(fs.opendir('/file')).rejects.toMatchObject({code: 'ENOTDIR'});
    await expect(fs.opendir('/missing')).rejects.toMatchObject({
      code: 'ENOENT',
      message: "ENOENT: no such file or directory, opendir '/missing'",
    });
  });

  it('reports allocated blocks when set', async () => {
    const fs = createMockFileSystem();
    fs.writeFile('/sparse', '1gb', {blocks: 8});

    const stats = await fs.lstat('/sparse');
    expect(stats.size).toBe(1024 ** 3);
    expect(stats.blocks).toBe(8);
    expect(fs.diskUsage()).toBe(4096);
  });

  it('describes symbolic links with lstat but follows them with opendir', async () => {
    const fs = createMockFileSystem('/target\n  inner 1kb');
    fs.symlink('/link', 'target');

    const stats = await fs.lstat('/link');
    expect(stats.isDirectory()).toBe(false);
    expect(stats.size).toBe('target'.length);
    expect(await list(fs, '/link')).toEqual(['inner']);
    expect(fs.diskUsage()).toBe(1024 + 'target'.length);
  });

  it('supports mutation helpers', async () => {
    const fs = createMockFileSystem('/a\n  one 1kb');

    fs.writeFile('/a/two', '2kb');
    fs.writeFile('/new/nested/file', 5);
    fs.mkdir('/a', {size: 100});
    fs.add('/a', '/sub\n  three 3kb');
    fs.remove('/a/one');

    expect(await list(fs, '/a')).toEqual(['two', 'sub']);
    expect(fs.exists('/new/nested/file')).toBe(true);
    expect(fs.diskUsage('/a')).toBe(100 + 2048 + 3072);
    expect(() => fs.add('/a', 'two 1')).toThrow(/already exists/);
    expect(() => fs.remove('/nope')).toThrow(/does not exist/);

    fs.replace('only 1b');
    expect(await list(fs, '/')).toEqual(['only']);
  });

  it('injects failures until they are cleared', async () => {
    const fs = createMockFileSystem('/locked\n  secret 1kb');
    fs.fail('/locked', 'opendir', 'EACCES');

    await expect(fs.opendir('/locked')).rejects.toMatchObject({code: 'EACCES'});
    expect(fs.operationsFor({operation: 'opendir'})[0].error).toBe('EACCES');

    fs.clearFailure('/locked');
    expect(await list(fs, '/locked')).toEqual(['secret']);
  });

  it('can fail directory reads', async () => {
    const fs = createMockFileSystem('/dir\n  a 1');
    fs.fail('/dir', 'read', 'EIO');

    const directory = await fs.opendir('/dir');
    await expect(directory.read()).rejects.toMatchObject({code: 'EIO'});
    expect(fs.openHandles).toBe(1);
    await directory.close();
    expect(fs.openHandles).toBe(0);
  });

  it('rejects use of closed directory handles', async () => {
    const fs = createMockFileSystem('/dir');
    const directory = await fs.opendir('/dir');
    await directory.close();

    await expect(directory.read()).rejects.toMatchObject({code: 'ERR_DIR_CLOSED'});
    await expect(directory.close()).rejects.toMatchObject({code: 'ERR_DIR_CLOSED'});
  });

  it('snapshots directory entries when opened', async () => {
    const fs = createMockFileSystem('/dir\n  a 1\n  b 2');
    const directory = await fs.opendir('/dir');
    fs.remove('/dir/b');
    fs.writeFile('/dir/c', 3);

    expect((await directory.read())?.name).toBe('a');
    expect((await directory.read())?.name).toBe('b');
    expect(await directory.read()).toBeNull();
    await expect(fs.lstat('/dir/b')).rejects.toMatchObject({code: 'ENOENT'});
  });
});

describe('MockFileSystem timing', () => {
  it('charges fileMs for file stats and directoryMs for directory scans', async () => {
    const clock = new ManualClock();
    const fs = createMockFileSystem('/dir\n  file 1kb', {clock, fileMs: 10, directoryMs: 100});

    const fileStat = track(fs.lstat('/dir/file'));
    const dirStat = track(fs.lstat('/dir'));
    const open = track(fs.opendir('/dir'));

    await clock.flush();
    expect(dirStat.isSettled).toBe(true); // directory stats are free by default
    expect(fileStat.isSettled).toBe(false);

    await clock.advance(9);
    expect(fileStat.isSettled).toBe(false);
    await clock.advance(1);
    expect(fileStat.isSettled).toBe(true);
    expect(open.isSettled).toBe(false);

    await clock.advanceTo(100);
    expect(open.isSettled).toBe(true);

    // Reading entries costs nothing by default.
    const directory = await open.promise;
    const read = track(directory.read());
    await clock.flush();
    expect(read.isSettled).toBe(true);

    expect(fs.operations.map(({operation, startedAt, completedAt}) => [operation, startedAt, completedAt]))
      .toEqual([
        ['lstat', 0, 10],
        ['lstat', 0, 0],
        ['opendir', 0, 100],
        ['read', 100, 100],
      ]);
  });

  it('runs operations concurrently and tracks the peak', async () => {
    const clock = new ManualClock();
    const fs = createMockFileSystem('a 1\nb 1\nc 1', {clock, fileMs: 10});

    const stats = Promise.all(['/a', '/b', '/c'].map(path => fs.lstat(path)));
    expect(fs.inFlight).toBe(3);
    await clock.advance(10);
    await stats;
    expect(fs.inFlight).toBe(0);
    expect(fs.maxInFlight).toBe(3);
  });

  it('supports per-path delays and readMs', async () => {
    const clock = new ManualClock();
    const fs = createMockFileSystem('/slow\n  a 1', {clock, directoryMs: 10, readMs: 5});
    fs.setDelay('/slow', 'opendir', 1000);

    const open = track(fs.opendir('/slow'));
    await clock.advance(999);
    expect(open.isSettled).toBe(false);
    await clock.advance(1);
    const read = track((await open.promise).read());
    await clock.advance(4);
    expect(read.isSettled).toBe(false);
    await clock.advance(1);
    expect((await read.promise)?.name).toBe('a');
  });

  it('holds operations at gates and completes them with the current state', async () => {
    const clock = new ManualClock();
    const fs = createMockFileSystem('file 1kb', {clock, fileMs: 10});
    const gate = fs.hold('/file', 'lstat');

    const held = track(fs.lstat('/file'));
    const unheld = track(fs.lstat('/file')); // gates only hold one operation
    await clock.advance(10);
    await gate.whenReached();
    expect(gate.reached).toBe(true);
    expect(unheld.isSettled).toBe(true);
    expect(held.isSettled).toBe(false);

    await clock.advance(1000);
    expect(held.isSettled).toBe(false);

    fs.writeFile('/file', '2kb');
    gate.release();
    expect((await held.promise).size).toBe(2048);
  });

  it('can fail a held operation', async () => {
    const fs = createMockFileSystem('/dir');
    const gate = fs.hold('/dir', 'opendir');
    const open = fs.opendir('/dir');
    await gate.whenReached();
    gate.fail('EACCES');
    await expect(open).rejects.toMatchObject({code: 'EACCES'});
  });
});

describe('ManualClock', () => {
  it('fires timers in order and only when time advances', async () => {
    const clock = new ManualClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 20);
    clock.setTimeout(() => fired.push('a'), 10);
    clock.setTimeout(() => fired.push('a2'), 10);
    const cancelled = clock.setTimeout(() => fired.push('never'), 5);
    clock.clearTimeout(cancelled);

    await clock.advance(15);
    expect(fired).toEqual(['a', 'a2']);
    expect(clock.now()).toBe(1015);
    expect(clock.nextTimerAt).toBe(1020);

    await clock.runAll();
    expect(fired).toEqual(['a', 'a2', 'b']);
    expect(clock.now()).toBe(1020);
    expect(clock.pendingTimers).toBe(0);
  });

  it('lets promise chains react between timers', async () => {
    const clock = new ManualClock();
    const events: number[] = [];
    void (async () => {
      await clock.sleep(10);
      events.push(clock.now());
      await clock.sleep(10);
      events.push(clock.now());
    })();

    await clock.advance(25);
    expect(events).toEqual([10, 20]);
  });

  it('refuses to go backwards and stops runaway timers', async () => {
    const clock = new ManualClock(10);
    await expect(clock.advanceTo(5)).rejects.toThrow(/backwards/);

    const loop = () => clock.setTimeout(loop, 1);
    loop();
    await expect(clock.runAll({limit: 50})).rejects.toThrow(/more than 50/);
  });
});
