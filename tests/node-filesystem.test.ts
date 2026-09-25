import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createDiskUsageScanner} from '../disk-usage.js';
import {nodeFileSystem} from '../filesystem.js';
import {expectConsistentReport} from './helpers/scanner.js';

describe('nodeFileSystem', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hdd-test-'));
    await mkdir(join(root, 'nested', 'deeper'), {recursive: true});
    await writeFile(join(root, 'top.txt'), 'x'.repeat(10_000));
    await writeFile(join(root, 'nested', 'deeper', 'inner.txt'), 'y'.repeat(20_000));
    await symlink(join(root, 'nested'), join(root, 'link'));
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('lists and stats real entries', async () => {
    const directory = await nodeFileSystem.opendir(root);
    const names: string[] = [];
    for (let entry = await directory.read(); entry; entry = await directory.read()) {
      names.push(entry.name);
    }
    await directory.close();

    expect(names.sort()).toEqual(['link', 'nested', 'top.txt']);
    expect((await nodeFileSystem.lstat(join(root, 'nested'))).isDirectory()).toBe(true);
    expect((await nodeFileSystem.lstat(join(root, 'link'))).isDirectory()).toBe(false);
    expect((await nodeFileSystem.lstat(join(root, 'top.txt'))).size).toBe(10_000);
  });

  it('reports directory identities', async () => {
    const stats = await nodeFileSystem.lstat(join(root, 'nested'));
    expect(stats.dev).toBeDefined();
    expect(stats.ino).toBeDefined();
    const ino = stats.ino!;
    expect(typeof ino === 'bigint' || Number.isSafeInteger(ino)).toBe(true);
  });

  it('scans a real directory by default', async () => {
    const report = await createDiskUsageScanner(root).wait();

    expect(report.isComplete).toBe(true);
    expect(report.errors).toEqual([]);
    expect([...report.files.keys()].sort()).toEqual([
      '.',
      'link',
      'nested',
      'nested/deeper',
      'nested/deeper/inner.txt',
      'top.txt',
    ]);
    // Allocated sizes vary by platform, but data files occupy at least some space.
    expect(report.files.get('nested/deeper/inner.txt')!.size).toBeGreaterThan(0);
    expect(report.files.get('top.txt')!.size).toBeGreaterThan(0);
    expect(report.files.get('link')!.isDirectory).toBe(false);
    expectConsistentReport(report);
  });
});
