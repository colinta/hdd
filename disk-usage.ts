import {promises as fs, type Dir, type Stats} from 'fs';
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
  subscribe(listener: () => void): () => void;
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
  committedSize: number;
  ownSize: number;
  isDirectory: boolean;
  isComplete: boolean;
  entriesRead: boolean;
  pendingChildren: number;
  error: Error | null;
  children: MutableFileInfo[];
  parent: MutableFileInfo | null;
  refresh(): Promise<void>;
  recalculate(): void;
  abort(): void;
  ignore(): void;
}

interface ScanJob {
  id: number;
  controller: AbortController;
  root: MutableFileInfo;
  oldRoot: MutableFileInfo | null;
  oldParent: MutableFileInfo | null;
  oldIndex: number;
  errors: DiskUsageError[];
  fatalError: Error | null;
  rootWasDeleted: boolean;
  pendingDirectories: number;
  startedAt: number;
  completedAt: number | null;
  done: Promise<void>;
  resolveDone: () => void;
  isSettled: boolean;
}

type ScanTask =
  | {type: 'stat'; absolutePath: string; parent: MutableFileInfo | null; node?: MutableFileInfo}
  | {type: 'open'; node: MutableFileInfo}
  | {type: 'read'; node: MutableFileInfo; directory: Dir};

class TraversalAbortedError extends Error {
  constructor() {
    super('Disk usage scan aborted');
    this.name = 'AbortError';
  }
}

const IO_CONCURRENCY = 8;
const NOTIFICATION_INTERVAL_MS = 50;

export function createDiskUsageScanner(rootPath: string): DiskUsageScanner {
  const rootAbsolutePath = resolve(rootPath);
  const ignoredPaths = new Set<string>();
  const listeners = new Set<() => void>();
  const files = new Map<string, MutableFileInfo>();
  let visibleRoot = createMutableFileInfo(rootAbsolutePath, null, true);
  let activeJob: ScanJob | null = null;
  let operationId = 0;
  let refreshRequestId = 0;
  let filesScanned = 0;
  let directoriesScanned = 0;
  let committedErrors: DiskUsageError[] = [];
  let lastOperationErrors: DiskUsageError[] = [];
  let isAborted = false;
  let startedAt = Date.now();
  let completedAt: number | null = null;
  let notificationTimer: ReturnType<typeof setTimeout> | null = null;

  addSubtreeToIndex(visibleRoot);
  void startScan('.');

  function createMutableFileInfo(
    absolutePath: string,
    parent: MutableFileInfo | null,
    isDirectory: boolean,
  ): MutableFileInfo {
    const relativePath = relative(rootAbsolutePath, absolutePath);
    const path = parent ? relativePath || basename(absolutePath) : rootAbsolutePath;

    const info: MutableFileInfo = {
      path,
      absolutePath,
      name: basename(absolutePath) || absolutePath,
      size: 0,
      committedSize: 0,
      ownSize: 0,
      isDirectory,
      isComplete: false,
      entriesRead: false,
      pendingChildren: 0,
      error: null,
      children: [],
      parent,
      refresh: () => refreshPath(absolutePath),
      recalculate() {
        // Sizes are updated incrementally by the active subtree scan.
      },
      abort: abortScan,
      ignore: () => ignorePath(absolutePath),
    };

    return info;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function scheduleNotification(): void {
    if (notificationTimer) {
      return;
    }

    notificationTimer = setTimeout(() => {
      notificationTimer = null;
      emitNow();
    }, NOTIFICATION_INTERVAL_MS);
    notificationTimer.unref?.();
  }

  function emitNow(): void {
    if (notificationTimer) {
      clearTimeout(notificationTimer);
      notificationTimer = null;
    }

    for (const listener of listeners) {
      listener();
    }
  }

  function createJob(root: MutableFileInfo, oldRoot: MutableFileInfo | null): ScanJob {
    let resolveDone = () => {};
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });

    return {
      id: ++operationId,
      controller: new AbortController(),
      root,
      oldRoot,
      oldParent: oldRoot?.parent ?? null,
      oldIndex: oldRoot?.parent ? oldRoot.parent.children.indexOf(oldRoot) : -1,
      errors: [],
      fatalError: null,
      rootWasDeleted: false,
      pendingDirectories: 0,
      startedAt: Date.now(),
      completedAt: null,
      done,
      resolveDone,
      isSettled: false,
    };
  }

  async function startScan(pathKey: string): Promise<void> {
    const requestId = ++refreshRequestId;
    const previousJob = activeJob;
    if (previousJob) {
      cancelJob(previousJob, true);
      await previousJob.done;
    }

    // Several refreshes can be requested while an old job is draining. Only the latest starts.
    if (requestId !== refreshRequestId) {
      return;
    }

    if (pathKey !== '.' && !files.has(pathKey)) {
      const error = new Error(`Cannot refresh "${pathKey}": it is not in the current scan`);
      lastOperationErrors = [makeErrorReport(pathKey, error)];
      completedAt = Date.now();
      emitNow();
      return;
    }

    // A partial initial tree has no committed rollback point. Restart it from the root.
    const requested = files.get(pathKey) ?? visibleRoot;
    const oldRoot = requested.committedSize > 0 || requested.isComplete ? requested : null;
    const scanPath = oldRoot ? pathKey : '.';
    const replaced = oldRoot ?? visibleRoot;
    const staging = createMutableFileInfo(replaced.absolutePath, replaced.parent, replaced.isDirectory);
    const job = createJob(staging, oldRoot);

    activeJob = job;
    isAborted = false;
    startedAt = job.startedAt;
    completedAt = null;
    lastOperationErrors = [];

    attachStagingTree(job, replaced);
    markAncestorsIncomplete(staging.parent);
    emitNow();

    runJob(job, scanPath).catch(caught => {
      if (!isAbortError(caught)) {
        job.fatalError = toError(caught);
      }
    });

    await job.done;
  }

  function attachStagingTree(job: ScanJob, replaced: MutableFileInfo): void {
    removeSubtreeFromIndex(replaced);

    if (replaced.parent) {
      const index = replaced.parent.children.indexOf(replaced);
      job.oldIndex = index;
      replaced.parent.children[index] = job.root;
      job.root.parent = replaced.parent;
      addSizeToAncestors(replaced.parent, -replaced.size);
    } else {
      visibleRoot = job.root;
    }

    addSubtreeToIndex(job.root);
  }

  async function runJob(job: ScanJob, pathKey: string): Promise<void> {
    const tasks: ScanTask[] = [
      {type: 'stat', absolutePath: job.root.absolutePath, parent: job.root.parent, node: job.root},
    ];
    const openDirectories = new Set<Dir>();
    let taskIndex = 0;
    let activeTasks = 0;

    const enqueue = (task: ScanTask): void => {
      if (!job.controller.signal.aborted && activeJob === job) {
        tasks.push(task);
      }
    };

    const finishIfIdle = async (): Promise<void> => {
      if (job.isSettled || activeTasks !== 0 || taskIndex < tasks.length) {
        return;
      }

      for (const directory of openDirectories) {
        await directory.close().catch(() => {});
      }
      openDirectories.clear();
      settleJob(job, pathKey);
    };

    const pump = (): void => {
      if (job.isSettled) {
        return;
      }

      if (job.controller.signal.aborted || activeJob !== job) {
        taskIndex = tasks.length;
      }

      while (
        !job.controller.signal.aborted &&
        activeJob === job &&
        activeTasks < IO_CONCURRENCY &&
        taskIndex < tasks.length
      ) {
        const task = tasks[taskIndex++];
        activeTasks += 1;

        executeTask(job, task, enqueue, openDirectories)
          .catch(caught => {
            if (!isAbortError(caught)) {
              const error = toError(caught);
              job.fatalError = job.fatalError ?? error;
            }
          })
          .finally(() => {
            activeTasks -= 1;
            if (taskIndex > 1024 && taskIndex * 2 > tasks.length) {
              tasks.splice(0, taskIndex);
              taskIndex = 0;
            }
            pump();
            void finishIfIdle();
          });
      }

      void finishIfIdle();
    };

    const onAbort = (): void => {
      taskIndex = tasks.length;
      pump();
    };
    job.controller.signal.addEventListener('abort', onAbort, {once: true});
    pump();
    await job.done;
    job.controller.signal.removeEventListener('abort', onAbort);
  }

  async function executeTask(
    job: ScanJob,
    task: ScanTask,
    enqueue: (task: ScanTask) => void,
    openDirectories: Set<Dir>,
  ): Promise<void> {
    throwIfJobInactive(job);

    if (task.type === 'stat') {
      await executeStatTask(job, task, enqueue);
      return;
    }

    if (task.type === 'open') {
      let directory: Dir | null = null;
      try {
        directory = await fs.opendir(task.node.absolutePath);
        openDirectories.add(directory);
        throwIfJobInactive(job);
        enqueue({type: 'read', node: task.node, directory});
      } catch (caught) {
        if (directory) {
          openDirectories.delete(directory);
          await directory.close().catch(() => {});
        }
        if (isAbortError(caught)) {
          throw caught;
        }
        const error = toError(caught);
        if (task.node === job.root && job.oldParent && isNotFoundError(error)) {
          job.rootWasDeleted = true;
        } else {
          recordError(job, task.node, error);
        }
        task.node.entriesRead = true;
        job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
        maybeCompleteNode(job, task.node);
      }
      return;
    }

    try {
      const dirent = await task.directory.read();
      throwIfJobInactive(job);

      if (!dirent) {
        openDirectories.delete(task.directory);
        await task.directory.close().catch(() => {});
        throwIfJobInactive(job);
        task.node.entriesRead = true;
        job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
        maybeCompleteNode(job, task.node);
        scheduleNotification();
        return;
      }

      const absolutePath = join(task.node.absolutePath, dirent.name);
      const childKey = pathKeyForAbsolutePath(absolutePath);
      if (!ignoredPaths.has(childKey)) {
        task.node.pendingChildren += 1;
        enqueue({type: 'stat', absolutePath, parent: task.node});
      }
      enqueue(task);
    } catch (caught) {
      openDirectories.delete(task.directory);
      await task.directory.close().catch(() => {});
      if (isAbortError(caught)) {
        throw caught;
      }
      const error = toError(caught);
      if (task.node === job.root && job.oldParent && isNotFoundError(error)) {
        job.rootWasDeleted = true;
      } else {
        recordError(job, task.node, error);
      }
      task.node.entriesRead = true;
      job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
      maybeCompleteNode(job, task.node);
    }
  }

  async function executeStatTask(
    job: ScanJob,
    task: Extract<ScanTask, {type: 'stat'}>,
    enqueue: (task: ScanTask) => void,
  ): Promise<void> {
    let stats: Stats;
    try {
      stats = await fs.lstat(task.absolutePath);
      throwIfJobInactive(job);
    } catch (caught) {
      if (isAbortError(caught)) {
        throw caught;
      }

      const error = toError(caught);
      const pathKey = pathKeyForAbsolutePath(task.absolutePath);
      if (task.node === job.root && job.oldParent && isNotFoundError(error)) {
        job.rootWasDeleted = true;
        task.node.isComplete = true;
      } else {
        recordErrorAtPath(job, pathKey, error);
      }
      if (task.node === job.root && !job.rootWasDeleted) {
        job.fatalError = error;
        task.node.error = error;
        task.node.isComplete = true;
      } else if (!task.node && task.parent) {
        childFinished(job, task.parent);
      }
      return;
    }

    const isDirectory = stats.isDirectory();
    const node = task.node ?? createMutableFileInfo(task.absolutePath, task.parent, isDirectory);
    setNodeType(node, isDirectory);
    node.ownSize = sizeOnDisk(stats);
    node.size = node.ownSize;
    node.entriesRead = !isDirectory;
    node.isComplete = !isDirectory;
    node.error = null;

    if (!task.node && task.parent) {
      task.parent.children.push(node);
      addSubtreeToIndex(node);
    }

    addSizeToAncestors(node.parent, node.ownSize);

    if (isDirectory) {
      job.pendingDirectories += 1;
      enqueue({type: 'open', node});
    } else if (node !== job.root && node.parent) {
      childFinished(job, node.parent);
    }

    scheduleNotification();
  }

  function maybeCompleteNode(job: ScanJob, node: MutableFileInfo): void {
    if (node.isComplete || !node.entriesRead || node.pendingChildren !== 0) {
      return;
    }

    node.isComplete = true;
    if (node !== job.root && node.parent) {
      childFinished(job, node.parent);
    }
  }

  function childFinished(job: ScanJob, parent: MutableFileInfo): void {
    parent.pendingChildren = Math.max(0, parent.pendingChildren - 1);
    maybeCompleteNode(job, parent);
  }

  function settleJob(job: ScanJob, pathKey: string): void {
    if (job.isSettled) {
      return;
    }
    job.isSettled = true;
    job.completedAt = Date.now();

    const wasAborted = job.controller.signal.aborted || activeJob !== job;
    if (wasAborted || (job.fatalError && job.oldRoot)) {
      rollbackJob(job);
      lastOperationErrors = job.fatalError ? [...job.errors] : [];
    } else if (job.rootWasDeleted) {
      commitDeletedJob(job, pathKey);
    } else {
      commitJob(job, pathKey);
    }

    if (activeJob === job) {
      activeJob = null;
      isAborted = wasAborted;
      completedAt = job.completedAt;
    }

    job.resolveDone();
    emitNow();
  }

  function commitJob(job: ScanJob, pathKey: string): void {
    commitSubtreeSizes(job.root);
    for (let ancestor = job.root.parent; ancestor; ancestor = ancestor.parent) {
      ancestor.committedSize = ancestor.size;
      ancestor.isComplete = true;
    }

    committedErrors = committedErrors.filter(
      error => !isSameOrDescendantPath(error.path, pathKey),
    );
    committedErrors.push(...job.errors);
    lastOperationErrors = [];
  }

  function commitDeletedJob(job: ScanJob, pathKey: string): void {
    const parent = job.oldParent;
    if (!parent) {
      // The scanner root cannot be removed from a parent tree. Root failures remain errors.
      rollbackJob(job);
      return;
    }

    removeSubtreeFromIndex(job.root);
    const index = parent.children.indexOf(job.root);
    if (index >= 0) {
      parent.children.splice(index, 1);
    }
    addSizeToAncestors(parent, -job.root.size);
    restoreCommittedAncestors(parent);

    committedErrors = committedErrors.filter(
      error => !isSameOrDescendantPath(error.path, pathKey),
    );
    lastOperationErrors = [];
  }

  function rollbackJob(job: ScanJob): void {
    if (!job.oldRoot) {
      // An initial scan has no previous complete tree to restore. Keep its partial result visible.
      return;
    }

    removeSubtreeFromIndex(job.root);
    if (job.oldParent) {
      const currentIndex = job.oldParent.children.indexOf(job.root);
      const index = currentIndex >= 0 ? currentIndex : job.oldIndex;
      job.oldParent.children[index] = job.oldRoot;
      addSizeToAncestors(job.oldParent, job.oldRoot.size - job.root.size);
      restoreCommittedAncestors(job.oldParent);
    } else {
      visibleRoot = job.oldRoot;
    }
    addSubtreeToIndex(job.oldRoot);
  }

  function cancelJob(job: ScanJob, rollbackImmediately: boolean): void {
    if (job.isSettled) {
      return;
    }

    job.controller.abort();
    if (rollbackImmediately && job.oldRoot && activeJob === job) {
      rollbackJob(job);
      // Prevent settleJob from rolling the same tree back twice.
      job.oldRoot = null;
    }
  }

  function abortScan(): void {
    refreshRequestId += 1;
    const job = activeJob;
    if (!job) {
      return;
    }

    isAborted = true;
    completedAt = Date.now();
    cancelJob(job, true);
    emitNow();
  }

  async function refreshPath(path = '.'): Promise<void> {
    let pathKey: string;
    try {
      pathKey = normalizePathKey(path);
    } catch (caught) {
      lastOperationErrors = [makeErrorReport(path, toError(caught))];
      emitNow();
      return;
    }

    await startScan(pathKey);
  }

  async function waitForCurrentRun(): Promise<ProgressReport> {
    while (activeJob) {
      const job = activeJob;
      await job.done;
      if (activeJob === job) {
        break;
      }
    }
    return getReport();
  }

  function ignorePath(path: string): void {
    const pathKey = normalizePathKey(path);
    if (pathKey === '.') {
      return;
    }

    ignoredPaths.add(pathKey);
    refreshRequestId += 1;
    if (activeJob) {
      cancelJob(activeJob, true);
    }

    const info = files.get(pathKey);
    if (!info) {
      emitNow();
      return;
    }

    removeSubtreeFromIndex(info);
    if (info.parent) {
      info.parent.children = info.parent.children.filter(child => child !== info);
      addSizeToAncestors(info.parent, -info.size);
      restoreCommittedAncestors(info.parent);
    }
    committedErrors = committedErrors.filter(
      error => !isSameOrDescendantPath(error.path, pathKey),
    );
    emitNow();
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

  function pathKeyForAbsolutePath(absolutePath: string): string {
    const relativePath = relative(rootAbsolutePath, absolutePath);
    return relativePath || '.';
  }

  function getReport(): ProgressReport {
    const errors = [...committedErrors, ...lastOperationErrors];
    if (activeJob) {
      errors.push(...activeJob.errors);
    }
    const elapsedCompletedAt = completedAt;

    return {
      path: visibleRoot.path,
      absolutePath: visibleRoot.absolutePath,
      name: visibleRoot.name,
      size: visibleRoot.size,
      isDirectory: visibleRoot.isDirectory,
      isComplete: !activeJob && visibleRoot.isComplete,
      children: visibleRoot.children,
      refresh: () => refreshPath('.'),
      recalculate() {},
      abort: abortScan,
      ignore() {},
      rootPath: rootAbsolutePath,
      files: files as unknown as Map<string, FileInfo>,
      errors,
      error: errors.length ? new Error(errors[0].message) : null,
      filesScanned,
      directoriesScanned,
      entriesScanned: filesScanned + directoriesScanned,
      pendingDirectories: activeJob?.pendingDirectories ?? 0,
      isAborted,
      startedAt,
      completedAt: elapsedCompletedAt,
      elapsedMs: (elapsedCompletedAt ?? Date.now()) - startedAt,
    };
  }

  function setNodeType(node: MutableFileInfo, isDirectory: boolean): void {
    if (node.isDirectory === isDirectory) {
      return;
    }

    if (node.isDirectory) {
      directoriesScanned -= 1;
      filesScanned += 1;
    } else {
      filesScanned -= 1;
      directoriesScanned += 1;
    }
    node.isDirectory = isDirectory;
  }

  function addSubtreeToIndex(node: MutableFileInfo): void {
    const key = pathKeyForAbsolutePath(node.absolutePath);
    if (!files.has(key)) {
      if (node.isDirectory) {
        directoriesScanned += 1;
      } else {
        filesScanned += 1;
      }
    }
    files.set(key, node);
    for (const child of node.children) {
      addSubtreeToIndex(child);
    }
  }

  function removeSubtreeFromIndex(node: MutableFileInfo): void {
    for (const child of node.children) {
      removeSubtreeFromIndex(child);
    }
    const key = pathKeyForAbsolutePath(node.absolutePath);
    if (files.get(key) === node) {
      files.delete(key);
      if (node.isDirectory) {
        directoriesScanned = Math.max(0, directoriesScanned - 1);
      } else {
        filesScanned = Math.max(0, filesScanned - 1);
      }
    }
  }

  function addSizeToAncestors(node: MutableFileInfo | null, delta: number): void {
    for (let current = node; current; current = current.parent) {
      current.size += delta;
      current.isComplete = false;
    }
  }

  function restoreCommittedAncestors(node: MutableFileInfo | null): void {
    for (let current = node; current; current = current.parent) {
      current.committedSize = current.size;
      current.isComplete = true;
    }
  }

  function markAncestorsIncomplete(node: MutableFileInfo | null): void {
    for (let current = node; current; current = current.parent) {
      current.isComplete = false;
    }
  }

  function commitSubtreeSizes(node: MutableFileInfo): void {
    node.committedSize = node.size;
    for (const child of node.children) {
      commitSubtreeSizes(child);
    }
  }

  function recordError(job: ScanJob, info: MutableFileInfo, error: Error): void {
    info.error = error;
    recordErrorAtPath(job, pathKeyForAbsolutePath(info.absolutePath), error);
  }

  function recordErrorAtPath(job: ScanJob, path: string, error: Error): void {
    job.errors.push(makeErrorReport(path, error));
  }

  function makeErrorReport(path: string, error: Error): DiskUsageError {
    const code = getErrorCode(error);
    return {
      path: path || '.',
      message: error.message,
      ...(code ? {code} : {}),
    };
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

  function throwIfJobInactive(job: ScanJob): void {
    if (job.controller.signal.aborted || activeJob !== job) {
      throw new TraversalAbortedError();
    }
  }

  return {
    getReport,
    subscribe,
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
