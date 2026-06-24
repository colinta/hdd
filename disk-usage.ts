import {promises as fs, type Stats} from 'fs';
import {basename, join, relative, resolve} from 'path';

export interface FileInfo {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  isDirectory: boolean;
  isComplete: boolean;
  error: Error | null;
  children: FileInfo[];
  refresh(): Promise<void>;
  recalculate(): void;
  abort(): void;
}

export interface DiskUsageError {
  path: string;
  message: string;
  code?: string;
}

export interface ProgressReport extends FileInfo {
  rootPath: string;
  files: Map<string, FileInfo>;
  errors: DiskUsageError[];
  error: Error | null;
  filesScanned: number;
  directoriesScanned: number;
  entriesScanned: number;
  pendingDirectories: number;
  isAborted: boolean;
  startedAt: number;
  completedAt: number | null;
  elapsedMs: number;
}

export interface DiskUsageScanner {
  getReport(): ProgressReport;
  refresh(): Promise<void>;
  abort(): void;
}

interface MutableFileInfo {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  ownSize: number;
  isDirectory: boolean;
  isComplete: boolean;
  error: Error | null;
  children: MutableFileInfo[];
  parent: MutableFileInfo | null;
}

interface ScanRun {
  controller: AbortController;
  root: MutableFileInfo;
  files: Map<string, MutableFileInfo>;
  errors: DiskUsageError[];
  error: Error | null;
  filesScanned: number;
  directoriesScanned: number;
  pendingDirectories: number;
  isComplete: boolean;
  isAborted: boolean;
  startedAt: number;
  completedAt: number | null;
  done: Promise<void>;
}

class TraversalAbortedError extends Error {
  constructor() {
    super('Disk usage scan aborted');
    this.name = 'AbortError';
  }
}

export function createDiskUsageScanner(rootPath: string): DiskUsageScanner {
  const rootAbsolutePath = resolve(rootPath);
  let currentRun = createRun();

  function createMutableFileInfo(
    absolutePath: string,
    parent: MutableFileInfo | null,
    isDirectory: boolean,
    stats?: Stats,
  ): MutableFileInfo {
    const size = stats ? sizeOnDisk(stats) : 0;
    const relativePath = parent ? relative(rootAbsolutePath, absolutePath) : rootAbsolutePath;

    return {
      path: relativePath || basename(absolutePath) || absolutePath,
      absolutePath,
      name: basename(absolutePath) || absolutePath,
      size,
      ownSize: size,
      isDirectory,
      isComplete: !isDirectory,
      error: null,
      children: [],
      parent,
    };
  }

  function createRun(): ScanRun {
    const controller = new AbortController();
    const root = createMutableFileInfo(rootAbsolutePath, null, true);
    const run: ScanRun = {
      controller,
      root,
      files: new Map([['.', root]]),
      errors: [],
      error: null,
      filesScanned: 0,
      directoriesScanned: 0,
      pendingDirectories: 0,
      isComplete: false,
      isAborted: false,
      startedAt: Date.now(),
      completedAt: null,
      done: Promise.resolve(),
    };
    return run;
  }

  function startScan(): Promise<void> {
    currentRun.controller.abort();

    const run = createRun();
    currentRun = run;
    run.done = scan(run);
    return run.done;
  }

  function abortScan(): void {
    currentRun.isAborted = true;
    currentRun.completedAt = currentRun.completedAt ?? Date.now();
    currentRun.controller.abort();
  }

  function getReport(): ProgressReport {
    const run = currentRun;
    const snapshots = new Map<MutableFileInfo, FileInfo>();
    const rootSnapshot = snapshotFileInfo(run.root, snapshots);
    const fileSnapshots = new Map<string, FileInfo>();

    for (const [path, info] of run.files) {
      fileSnapshots.set(path, snapshotFileInfo(info, snapshots));
    }

    return {
      ...rootSnapshot,
      rootPath: rootAbsolutePath,
      files: fileSnapshots,
      errors: [...run.errors],
      error: run.error,
      filesScanned: run.filesScanned,
      directoriesScanned: run.directoriesScanned,
      entriesScanned: run.filesScanned + run.directoriesScanned,
      pendingDirectories: run.pendingDirectories,
      isComplete: run.isComplete,
      isAborted: run.isAborted,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      elapsedMs: (run.completedAt ?? Date.now()) - run.startedAt,
      refresh: startScan,
      abort: abortScan,
    };
  }

  function snapshotFileInfo(
    info: MutableFileInfo,
    snapshots: Map<MutableFileInfo, FileInfo>,
  ): FileInfo {
    const existing = snapshots.get(info);
    if (existing) {
      return existing;
    }

    const snapshot: FileInfo = {
      path: info.path,
      absolutePath: info.absolutePath,
      name: info.name,
      size: info.size,
      isDirectory: info.isDirectory,
      isComplete: info.isComplete,
      error: info.error,
      children: [],
      refresh: startScan,
      recalculate() {
        // Sizes are maintained incrementally while the scan runs.
      },
      abort: abortScan,
    };

    snapshots.set(info, snapshot);
    snapshot.children = info.children.map(child => snapshotFileInfo(child, snapshots));
    return snapshot;
  }

  async function scan(run: ScanRun): Promise<void> {
    try {
      throwIfAborted(run);

      const rootStats = await fs.lstat(rootAbsolutePath);
      throwIfAborted(run);

      run.root.isDirectory = rootStats.isDirectory();
      run.root.ownSize = sizeOnDisk(rootStats);
      run.root.size = run.root.ownSize;
      run.root.isComplete = !run.root.isDirectory;

      if (run.root.isDirectory) {
        run.directoriesScanned = 1;
        await scanDirectory(run, run.root);
      } else {
        run.filesScanned = 1;
        run.root.isComplete = true;
      }

      throwIfAborted(run);
      run.isComplete = true;
      run.root.isComplete = true;
    } catch (caught) {
      if (isAbortError(caught)) {
        run.isAborted = true;
      } else {
        const error = toError(caught);
        run.error = error;
        recordError(run, run.root, error);
        run.root.isComplete = true;
        run.isComplete = true;
      }
    } finally {
      run.pendingDirectories = Math.max(0, run.pendingDirectories);
      run.completedAt = run.completedAt ?? Date.now();
    }
  }

  async function scanDirectory(run: ScanRun, directory: MutableFileInfo): Promise<void> {
    throwIfAborted(run);
    directory.isComplete = false;
    run.pendingDirectories += 1;

    try {
      const dir = await fs.opendir(directory.absolutePath);

      for await (const dirent of dir) {
        throwIfAborted(run);
        await scanDirent(run, directory, dirent.name);
      }

      directory.isComplete = true;
    } catch (caught) {
      if (isAbortError(caught)) {
        directory.isComplete = false;
        throw caught;
      }

      const error = toError(caught);
      recordError(run, directory, error);
      directory.isComplete = true;
    } finally {
      run.pendingDirectories = Math.max(0, run.pendingDirectories - 1);
    }
  }

  async function scanDirent(
    run: ScanRun,
    parent: MutableFileInfo,
    entryName: string,
  ): Promise<void> {
    const absolutePath = join(parent.absolutePath, entryName);

    let stats: Stats;
    try {
      stats = await fs.lstat(absolutePath);
    } catch (caught) {
      if (isAbortError(caught)) {
        throw caught;
      }
      if (!isNotFoundError(caught)) {
        recordErrorAtPath(run, relative(rootAbsolutePath, absolutePath), toError(caught));
      }
      return;
    }

    throwIfAborted(run);

    const isDirectory = stats.isDirectory();
    const child = createMutableFileInfo(absolutePath, parent, isDirectory, stats);
    parent.children.push(child);
    run.files.set(child.path, child);

    addSizeToAncestors(parent, child.ownSize);

    if (child.isDirectory) {
      run.directoriesScanned += 1;
      await scanDirectory(run, child);
    } else {
      run.filesScanned += 1;
      child.isComplete = true;
    }
  }

  function recordError(run: ScanRun, info: MutableFileInfo, error: Error): void {
    info.error = error;
    recordErrorAtPath(run, info.path, error);
  }

  function recordErrorAtPath(run: ScanRun, path: string, error: Error): void {
    const code = getErrorCode(error);
    const report: DiskUsageError = {
      path: path || '.',
      message: error.message,
      ...(code ? {code} : {}),
    };

    run.errors.push(report);
    run.error = run.error ?? error;
  }

  function addSizeToAncestors(info: MutableFileInfo, size: number): void {
    for (let current: MutableFileInfo | null = info; current; current = current.parent) {
      current.size += size;
    }
  }

  startScan();

  return {
    getReport,
    refresh: startScan,
    abort: abortScan,
  };
}

export function analyzeDiskUsage(rootPath: string): () => ProgressReport {
  const scanner = createDiskUsageScanner(rootPath);
  return scanner.getReport;
}

function throwIfAborted(run: ScanRun): void {
  if (run.controller.signal.aborted) {
    run.isAborted = true;
    throw new TraversalAbortedError();
  }
}

function isAbortError(caught: unknown): boolean {
  return caught instanceof TraversalAbortedError || toError(caught).name === 'AbortError';
}

function isNotFoundError(caught: unknown): boolean {
  const code = getErrorCode(caught);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function toError(caught: unknown): Error {
  if (caught instanceof Error) {
    return caught;
  }

  return new Error(String(caught));
}

function getErrorCode(caught: unknown): string | undefined {
  if (caught && typeof caught === 'object' && 'code' in caught) {
    const code = (caught as {code?: unknown}).code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

function sizeOnDisk(stats: Stats): number {
  const blocks = (stats as Stats & {blocks?: number}).blocks;

  if (typeof blocks === 'number' && Number.isFinite(blocks) && blocks >= 0) {
    return blocks * 512;
  }

  return stats.size;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) {
    return '0 B';
  }

  const sign = bytes < 0 ? '-' : '';
  const absoluteBytes = Math.abs(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const power = Math.min(
    Math.floor(Math.log(absoluteBytes) / Math.log(1024)),
    units.length - 1,
  );
  const size = absoluteBytes / Math.pow(1024, power);
  const decimals = power === 0 ? 0 : 2;

  return `${sign}${size.toFixed(decimals)} ${units[power]}`;
}
