import {promises as fs, type Stats} from 'fs';
import {basename, isAbsolute, join, relative, resolve, sep} from 'path';

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
  ignore(): void;
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
  refresh(path?: string): Promise<void>;
  ignore(path: string): void;
  abort(): void;
  wait(): Promise<ProgressReport>;
}

interface MutableFileInfo {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  ownSize: number;
  isDirectory: boolean;
  isComplete: boolean;
  entriesRead: boolean;
  pendingChildren: number;
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
  const ignoredPaths = new Set<string>();
  let currentRun = createRun();
  let operationId = 0;

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
      entriesRead: !isDirectory,
      pendingChildren: 0,
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
    operationId += 1;
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

  async function waitForCurrentRun(): Promise<ProgressReport> {
    const run = currentRun;
    await run.done;
    return getReport();
  }

  async function refreshPath(path = '.'): Promise<void> {
    const pathKey = normalizePathKey(path);
    if (pathKey === '.') {
      await startScan();
      return;
    }

    const run = currentRun;
    const previousDone = run.done;
    const refreshOperationId = ++operationId;

    if (!run.isComplete && !run.isAborted) {
      abortScan();
    }

    run.done = (async () => {
      await previousDone;
      if (refreshOperationId !== operationId || run !== currentRun) {
        return;
      }

      run.controller = new AbortController();
      run.isAborted = false;
      run.isComplete = false;
      run.completedAt = null;
      run.startedAt = Date.now();

      try {
        await refreshExistingPath(run, pathKey);
        throwIfAborted(run);
        run.isComplete = true;
      } catch (caught) {
        if (isAbortError(caught)) {
          run.isAborted = true;
        } else {
          const error = toError(caught);
          recordErrorAtPath(run, pathKey, error);
          run.isComplete = true;
        }
      } finally {
        run.pendingDirectories = Math.max(0, run.pendingDirectories);
        run.completedAt = run.completedAt ?? Date.now();
      }
    })();

    await run.done;
  }

  function ignorePath(path: string): void {
    const pathKey = normalizePathKey(path);
    if (pathKey === '.') {
      return;
    }

    ignoredPaths.add(pathKey);

    const run = currentRun;
    const info = run.files.get(pathKey);
    if (info) {
      removeInfoFromTree(run, info);
    }
  }

  function normalizePathKey(path: string): string {
    if (!path || path === '.' || path === rootAbsolutePath) {
      return '.';
    }

    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(rootAbsolutePath, path);
    const relativePath = relative(rootAbsolutePath, absolutePath);

    if (!relativePath) {
      return '.';
    }

    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Cannot refresh path outside scan root: ${path}`);
    }

    return relativePath;
  }

  function getReport(): ProgressReport {
    const run = currentRun;
    const snapshots = new Map<MutableFileInfo, FileInfo>();
    const rootSnapshot = snapshotFileInfo(run.root, snapshots);
    const fileSnapshots = new Map<string, FileInfo>();

    let filesScanned = 0;
    let directoriesScanned = 0;

    for (const [path, info] of run.files) {
      if (info.isDirectory) {
        directoriesScanned += 1;
      } else {
        filesScanned += 1;
      }

      fileSnapshots.set(path, snapshotFileInfo(info, snapshots));
    }

    return {
      ...rootSnapshot,
      rootPath: rootAbsolutePath,
      files: fileSnapshots,
      errors: [...run.errors],
      error: run.error,
      filesScanned,
      directoriesScanned,
      entriesScanned: filesScanned + directoriesScanned,
      pendingDirectories: run.pendingDirectories,
      isComplete: run.isComplete,
      isAborted: run.isAborted,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      elapsedMs: (run.completedAt ?? Date.now()) - run.startedAt,
      refresh: () => refreshPath('.'),
      abort: abortScan,
      ignore: () => ignorePath('.'),
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
      refresh: () => refreshPath(fileInfoKey(info)),
      recalculate() {
        // Sizes are maintained incrementally while the scan runs.
      },
      abort: abortScan,
      ignore: () => ignorePath(fileInfoKey(info)),
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

  async function scanDirectory(
    run: ScanRun,
    root: MutableFileInfo,
    completionBoundary: MutableFileInfo | null = null,
  ): Promise<void> {
    const queue: MutableFileInfo[] = [root];
    const waiters: (() => void)[] = [];
    let remainingDirectories = 1;

    function enqueue(directory: MutableFileInfo): void {
      remainingDirectories += 1;
      queue.push(directory);
      const waiter = waiters.shift();
      if (waiter) {
        waiter();
      }
    }

    function markMaybeComplete(directory: MutableFileInfo): void {
      if (directory.isComplete || !directory.entriesRead || directory.pendingChildren > 0) {
        return;
      }

      directory.isComplete = true;
      if (directory.parent && directory !== completionBoundary) {
        directory.parent.pendingChildren = Math.max(0, directory.parent.pendingChildren - 1);
        markMaybeComplete(directory.parent);
      }
    }

    async function nextDirectory(): Promise<MutableFileInfo | null> {
      while (!queue.length) {
        throwIfAborted(run);
        if (remainingDirectories === 0) {
          return null;
        }
        await new Promise<void>(resolve => {
          waiters.push(resolve);
        });
      }

      return queue.pop() ?? null;
    }

    async function worker(): Promise<void> {
      while (true) {
        const directory = await nextDirectory();
        if (!directory) {
          return;
        }

        await scanDirectoryEntries(run, directory, enqueue, markMaybeComplete);
        remainingDirectories -= 1;
        if (remainingDirectories === 0) {
          while (waiters.length) {
            waiters.shift()?.();
          }
        }
      }
    }

    const workerCount = 16;
    await Promise.all(Array.from({length: workerCount}, () => worker()));
  }

  async function scanDirectoryEntries(
    run: ScanRun,
    directory: MutableFileInfo,
    enqueue: (directory: MutableFileInfo) => void,
    markMaybeComplete: (directory: MutableFileInfo) => void,
  ): Promise<void> {
    throwIfAborted(run);
    directory.isComplete = false;
    directory.entriesRead = false;
    run.pendingDirectories += 1;

    try {
      const dirents = await fs.readdir(directory.absolutePath, {withFileTypes: true});

      const batchSize = 64;
      for (let index = 0; index < dirents.length; index += batchSize) {
        throwIfAborted(run);
        const end = Math.min(index + batchSize, dirents.length);
        const batch: Promise<void>[] = [];
        for (let batchIndex = index; batchIndex < end; batchIndex += 1) {
          batch.push(scanDirent(run, directory, dirents[batchIndex].name, enqueue));
        }
        await Promise.all(batch);
      }

      directory.entriesRead = true;
      markMaybeComplete(directory);
    } catch (caught) {
      if (isAbortError(caught)) {
        directory.isComplete = false;
        throw caught;
      }

      const error = toError(caught);
      recordError(run, directory, error);
      directory.entriesRead = true;
      markMaybeComplete(directory);
    } finally {
      run.pendingDirectories = Math.max(0, run.pendingDirectories - 1);
    }
  }

  async function scanDirent(
    run: ScanRun,
    parent: MutableFileInfo,
    entryName: string,
    enqueue: (directory: MutableFileInfo) => void,
  ): Promise<void> {
    const absolutePath = join(parent.absolutePath, entryName);

    if (ignoredPaths.has(relative(rootAbsolutePath, absolutePath))) {
      return;
    }

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
      parent.pendingChildren += 1;
      run.directoriesScanned += 1;
      enqueue(child);
    } else {
      run.filesScanned += 1;
      child.isComplete = true;
    }
  }

  async function refreshExistingPath(run: ScanRun, pathKey: string): Promise<void> {
    const info = run.files.get(pathKey);
    if (!info) {
      recordErrorAtPath(
        run,
        pathKey,
        new Error(`Cannot refresh "${pathKey}": it is not in the current scan`),
      );
      return;
    }

    await refreshExistingInfo(run, info);
  }

  async function refreshExistingInfo(run: ScanRun, info: MutableFileInfo): Promise<void> {
    throwIfAborted(run);

    let stats: Stats;
    try {
      stats = await fs.lstat(info.absolutePath);
    } catch (caught) {
      if (isAbortError(caught)) {
        throw caught;
      }

      if (isNotFoundError(caught)) {
        removeInfoFromTree(run, info);
        return;
      }

      const error = toError(caught);
      removeErrorsForSubtree(run, info);
      recordError(run, info, error);
      info.isComplete = true;
      return;
    }

    throwIfAborted(run);

    const oldSize = info.size;
    removeErrorsForSubtree(run, info);
    removeDescendantsFromRun(run, info);

    info.isDirectory = stats.isDirectory();
    info.ownSize = sizeOnDisk(stats);
    info.size = info.ownSize;
    info.isComplete = !info.isDirectory;
    info.entriesRead = !info.isDirectory;
    info.pendingChildren = 0;
    info.error = null;

    addSizeToAncestors(info.parent, info.size - oldSize);

    if (info.isDirectory) {
      await scanDirectory(run, info, info);
    } else {
      info.isComplete = true;
    }
  }

  function removeInfoFromTree(run: ScanRun, info: MutableFileInfo): void {
    removeErrorsForSubtree(run, info);
    addSizeToAncestors(info.parent, -info.size);

    if (info.parent) {
      info.parent.children = info.parent.children.filter(child => child !== info);
      if (info.isDirectory && !info.isComplete) {
        info.parent.pendingChildren = Math.max(0, info.parent.pendingChildren - 1);
      }
    }

    removeInfoFromRun(run, info);
  }

  function removeDescendantsFromRun(run: ScanRun, info: MutableFileInfo): void {
    for (const child of info.children) {
      removeInfoFromRun(run, child);
    }

    info.children = [];
  }

  function removeInfoFromRun(run: ScanRun, info: MutableFileInfo): void {
    for (const child of info.children) {
      removeInfoFromRun(run, child);
    }

    run.files.delete(fileInfoKey(info));
  }

  function removeErrorsForSubtree(run: ScanRun, info: MutableFileInfo): void {
    const pathKey = fileInfoKey(info);
    run.errors = run.errors.filter(error => !isSameOrDescendantPath(error.path, pathKey));
    run.error = run.errors.length ? new Error(run.errors[0].message) : null;
    info.error = null;
  }

  function fileInfoKey(info: MutableFileInfo): string {
    return info.parent ? info.path : '.';
  }

  function isSameOrDescendantPath(path: string, ancestor: string): boolean {
    const normalizedPath = path || '.';
    const normalizedAncestor = ancestor || '.';
    return (
      normalizedAncestor === '.' ||
      normalizedPath === normalizedAncestor ||
      normalizedPath.startsWith(`${normalizedAncestor}${sep}`)
    );
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

  function addSizeToAncestors(info: MutableFileInfo | null, size: number): void {
    for (let current: MutableFileInfo | null = info; current; current = current.parent) {
      current.size += size;
    }
  }

  startScan();

  return {
    getReport,
    refresh: refreshPath,
    ignore: ignorePath,
    abort: abortScan,
    wait: waitForCurrentRun,
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

export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
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
