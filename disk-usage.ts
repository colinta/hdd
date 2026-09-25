import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'path';
import {systemClock, type Clock} from './clock.js';
import {
  nodeFileSystem,
  type FileSystem,
  type FileSystemDirectory,
  type FileSystemStats,
} from './filesystem.js';

type Dir = FileSystemDirectory;

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
  /** True while the active scan is paused. Elapsed time continues to include paused time. */
  isPaused: boolean;
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
  /**
   * Stops dispatching filesystem work for the active scan, retaining queued work and open
   * directories. Resolves once in-flight operations have finished. No-op when idle.
   */
  pause(): Promise<void>;
  /** Continues a paused scan from where it stopped. */
  resume(): void;
  wait(): Promise<ProgressReport>;
}

export interface DiskUsageScannerOptions {
  fileSystem?: FileSystem;
  clock?: Clock;
}

interface MutableFileInfo {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
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
  ancestorCompletion: Map<MutableFileInfo, boolean>;
  refreshedRoots: Set<MutableFileInfo>;
  enqueueTask: ((task: ScanTask) => void) | null;
  errors: DiskUsageError[];
  fatalError: Error | null;
  rootWasDeleted: boolean;
  pendingDirectories: number;
  startedAt: number;
  completedAt: number | null;
  done: Promise<void>;
  resolveDone: () => void;
  isSettled: boolean;
  activeTasks: number;
  idleWaiters: (() => void)[];
  dispatch: (() => void) | null;
  /** Set when everything the job was scanning has been ignored; it finishes without rollback. */
  isDiscarded: boolean;
}

type ScanTask =
  | {
      type: 'stat';
      absolutePath: string;
      pathKey: string;
      parent: MutableFileInfo | null;
      node?: MutableFileInfo;
    }
  | {type: 'open'; node: MutableFileInfo}
  | {type: 'read'; node: MutableFileInfo; directory: Dir};

class TraversalAbortedError extends Error {
  constructor() {
    super('Disk usage scan aborted');
    this.name = 'AbortError';
  }
}

const IO_CONCURRENCY = 8;
const MAX_OPEN_DIRECTORIES = 128;
const NOTIFICATION_INTERVAL_MS = 50;

export function createDiskUsageScanner(
  rootPath: string,
  options: DiskUsageScannerOptions = {},
): DiskUsageScanner {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const clock = options.clock ?? systemClock;
  const rootAbsolutePath = resolve(rootPath);
  const ignoredPaths = new Set<string>();
  const listeners = new Set<() => void>();
  const files = new Map<string, MutableFileInfo>();

  const emptyChildren: MutableFileInfo[] = [];

  class MutableFileInfoNode implements MutableFileInfo {
    size = 0;
    isComplete = false;
    entriesRead = false;
    pendingChildren = 0;
    error: Error | null = null;
    children: MutableFileInfo[] = [];

    constructor(
      public path: string,
      public isDirectory: boolean,
      public parent: MutableFileInfo | null,
    ) {}

    get absolutePath(): string {
      return this.parent ? join(rootAbsolutePath, this.path) : rootAbsolutePath;
    }

    get name(): string {
      return basename(this.path);
    }

    refresh(): Promise<void> {
      return refreshPath(this.absolutePath);
    }

    recalculate(): void {
      // Sizes are updated incrementally by the active subtree scan.
    }

    abort(): void {
      abortScan();
    }

    ignore(): void {
      ignorePath(this.absolutePath);
    }
  }

  class DirectoryInfoNode implements MutableFileInfo {
    size = 0;
    isComplete = false;
    entriesRead = false;
    pendingChildren = 0;

    constructor(
      public path: string,
      public parent: MutableFileInfo,
    ) {}

    get absolutePath(): string {
      return join(rootAbsolutePath, this.path);
    }

    get name(): string {
      return basename(this.path);
    }

    get isDirectory(): boolean {
      return true;
    }

    get children(): MutableFileInfo[] {
      return emptyChildren;
    }

    set children(children: MutableFileInfo[]) {
      if (children !== emptyChildren) {
        Object.defineProperty(this, 'children', {
          value: children,
          writable: true,
          configurable: true,
        });
      }
    }

    get error(): Error | null {
      return null;
    }

    set error(error: Error | null) {
      if (error) {
        Object.defineProperty(this, 'error', {
          value: error,
          writable: true,
          configurable: true,
        });
      }
    }

    refresh(): Promise<void> {
      return refreshPath(this.absolutePath);
    }

    recalculate(): void {
      // Sizes are updated incrementally by the active subtree scan.
    }

    abort(): void {
      abortScan();
    }

    ignore(): void {
      ignorePath(this.absolutePath);
    }
  }

  class CompletedFileInfoNode implements MutableFileInfo {
    constructor(
      public path: string,
      public size: number,
    ) {}

    get parent(): MutableFileInfo | null {
      return files.get(dirname(this.path)) ?? null;
    }

    get absolutePath(): string {
      return join(rootAbsolutePath, this.path);
    }

    get name(): string {
      return basename(this.path);
    }

    get isDirectory(): boolean {
      return false;
    }

    get isComplete(): boolean {
      return true;
    }

    get entriesRead(): boolean {
      return true;
    }

    get pendingChildren(): number {
      return 0;
    }

    get error(): Error | null {
      return null;
    }

    get children(): MutableFileInfo[] {
      return emptyChildren;
    }

    refresh(): Promise<void> {
      return refreshPath(this.absolutePath);
    }

    recalculate(): void {}

    abort(): void {
      abortScan();
    }

    ignore(): void {
      ignorePath(this.absolutePath);
    }
  }

  let visibleRoot = createMutableFileInfo(rootAbsolutePath, null, true);
  let activeJob: ScanJob | null = null;
  let operationId = 0;
  let refreshRequestId = 0;
  let filesScanned = 0;
  let directoriesScanned = 0;
  let committedErrors: DiskUsageError[] = [];
  let lastOperationErrors: DiskUsageError[] = [];
  let isAborted = false;
  // Pausing belongs to the scanner rather than a job, so a refresh requested while paused
  // replaces the work but stays paused.
  let isPaused = false;
  let startedAt = clock.now();
  let completedAt: number | null = null;
  let notificationTimer: unknown = null;

  addSubtreeToIndex(visibleRoot);
  void startScan('.');

  function createMutableFileInfo(
    absolutePath: string,
    parent: MutableFileInfo | null,
    isDirectory: boolean,
  ): MutableFileInfo {
    const relativePath = relative(rootAbsolutePath, absolutePath);
    const path = parent ? relativePath || basename(absolutePath) : rootAbsolutePath;

    return new MutableFileInfoNode(path, isDirectory, parent);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function scheduleNotification(): void {
    if (notificationTimer) {
      return;
    }

    notificationTimer = clock.setTimeout(() => {
      notificationTimer = null;
      emitNow();
    }, NOTIFICATION_INTERVAL_MS);
  }

  function emitNow(): void {
    if (notificationTimer) {
      clock.clearTimeout(notificationTimer);
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
    const ancestorCompletion = new Map<MutableFileInfo, boolean>();
    for (let ancestor = root.parent; ancestor; ancestor = ancestor.parent) {
      ancestorCompletion.set(ancestor, ancestor.isComplete);
    }

    return {
      id: ++operationId,
      controller: new AbortController(),
      root,
      oldRoot,
      oldParent: oldRoot?.parent ?? null,
      oldIndex: oldRoot?.parent ? oldRoot.parent.children.indexOf(oldRoot) : -1,
      ancestorCompletion,
      refreshedRoots: new Set(),
      enqueueTask: null,
      errors: [],
      fatalError: null,
      rootWasDeleted: false,
      pendingDirectories: 0,
      startedAt: clock.now(),
      completedAt: null,
      done,
      resolveDone,
      isSettled: false,
      activeTasks: 0,
      idleWaiters: [],
      dispatch: null,
      isDiscarded: false,
    };
  }

  async function startScan(requestedPathKey: string): Promise<void> {
    const requestId = ++refreshRequestId;
    const previousJob = activeJob;
    let pathKey = existingPathOrParent(requestedPathKey);

    if (previousJob && pathKey) {
      const jobPath = pathKeyForNode(previousJob.root);
      if (
        pathKey !== jobPath &&
        isSameOrDescendantPath(pathKey, jobPath) &&
        restartSubtreeInJob(previousJob, pathKey)
      ) {
        emitNow();
        await previousJob.done;
        return;
      }
    }

    if (previousJob) {
      cancelJob(previousJob, true);
      await previousJob.done;
    }

    // Several refreshes can be requested while an old job is draining. Only the latest starts.
    if (requestId !== refreshRequestId) {
      return;
    }

    pathKey = existingPathOrParent(requestedPathKey);
    if (!pathKey) {
      const error = new Error(
        `Cannot refresh "${requestedPathKey}": it is not in the current scan`,
      );
      lastOperationErrors = [makeErrorReport(requestedPathKey, error)];
      completedAt = clock.now();
      isPaused = false;
      emitNow();
      return;
    }

    const requested = files.get(pathKey) ?? visibleRoot;
    // Keep a partial subtree as the rollback point for a targeted refresh. Falling back to the
    // scanner root here makes a refresh button unexpectedly restart the entire tree.
    const canReplaceRequested = pathKey !== '.' || requested.isComplete;
    const oldRoot = canReplaceRequested ? requested : null;
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

  function existingPathOrParent(pathKey: string): string | null {
    if (pathKey === '.' || files.has(pathKey)) {
      return pathKey;
    }

    // A stale row can outlive its entry (for example, when an in-flight parent scan is
    // cancelled). Refresh its parent so the browser is reconciled with the filesystem.
    const parentPathKey = pathKeyForAbsolutePath(dirname(resolve(rootAbsolutePath, pathKey)));
    return parentPathKey !== pathKey && files.has(parentPathKey) ? parentPathKey : null;
  }

  function restartSubtreeInJob(job: ScanJob, pathKey: string): boolean {
    const replaced = files.get(pathKey);
    const parent = replaced?.parent;
    if (!replaced || !parent || !job.enqueueTask || job.isSettled) {
      return false;
    }

    const index = parent.children.indexOf(replaced);
    if (index < 0) {
      return false;
    }

    const wasComplete = replaced.isComplete;
    job.pendingDirectories = Math.max(
      0,
      job.pendingDirectories - countPendingDirectories(replaced),
    );
    removeSubtreeFromIndex(replaced);

    const staging = createMutableFileInfo(
      replaced.absolutePath,
      parent,
      replaced.isDirectory,
    );
    parent.children[index] = staging;
    addSizeToAncestors(parent, -replaced.size);
    if (wasComplete) {
      parent.pendingChildren += 1;
    }
    addSubtreeToIndex(staging);
    job.refreshedRoots.add(staging);
    job.errors = job.errors.filter(error => !isSameOrDescendantPath(error.path, pathKey));
    lastOperationErrors = [];
    isAborted = false;
    completedAt = null;
    job.enqueueTask({
      type: 'stat',
      absolutePath: staging.absolutePath,
      pathKey,
      parent,
      node: staging,
    });
    return true;
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
      {
        type: 'stat',
        absolutePath: job.root.absolutePath,
        pathKey,
        parent: job.root.parent,
        node: job.root,
      },
    ];
    const openDirectories = new Set<Dir>();
    const deferredOpenTasks: Extract<ScanTask, {type: 'open'}>[] = [];
    let taskIndex = 0;

    const enqueue = (task: ScanTask): void => {
      if (!job.controller.signal.aborted && activeJob === job) {
        tasks.push(task);
      }
    };

    const releaseDirectory = (directory: Dir): void => {
      openDirectories.delete(directory);
      if (openDirectories.size < MAX_OPEN_DIRECTORIES) {
        const deferred = deferredOpenTasks.pop();
        if (deferred) {
          enqueue(deferred);
        }
      }
    };

    const finishIfIdle = async (): Promise<void> => {
      if (job.isSettled || job.activeTasks !== 0 || taskIndex < tasks.length) {
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
        !isPaused &&
        job.activeTasks < IO_CONCURRENCY &&
        taskIndex < tasks.length
      ) {
        const task = tasks[taskIndex++];
        job.activeTasks += 1;

        executeTask(
          job,
          task,
          enqueue,
          openDirectories,
          deferredOpenTasks,
          releaseDirectory,
        )
          .catch(caught => {
            if (!isAbortError(caught)) {
              const error = toError(caught);
              job.fatalError = job.fatalError ?? error;
            }
          })
          .finally(() => {
            job.activeTasks -= 1;
            if (job.activeTasks === 0) {
              notifyIdleWaiters(job);
            }
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
    job.enqueueTask = task => {
      enqueue(task);
      pump();
    };
    job.dispatch = pump;
    job.controller.signal.addEventListener('abort', onAbort, {once: true});
    pump();
    await job.done;
    job.enqueueTask = null;
    job.dispatch = null;
    job.controller.signal.removeEventListener('abort', onAbort);
  }

  async function executeTask(
    job: ScanJob,
    task: ScanTask,
    enqueue: (task: ScanTask) => void,
    openDirectories: Set<Dir>,
    deferredOpenTasks: Extract<ScanTask, {type: 'open'}>[],
    releaseDirectory: (directory: Dir) => void,
  ): Promise<void> {
    if (task.type === 'read' && !isNodeActive(job, task.node)) {
      // The directory was ignored or replaced while this read was queued; release its handle.
      releaseDirectory(task.directory);
      await task.directory.close().catch(() => {});
      throw new TraversalAbortedError();
    }
    throwIfNodeInactive(job, task.type === 'stat' ? task.node ?? task.parent : task.node);

    if (task.type === 'stat') {
      await executeStatTask(job, task, enqueue);
      return;
    }

    if (task.type === 'open') {
      if (openDirectories.size >= MAX_OPEN_DIRECTORIES) {
        deferredOpenTasks.push(task);
        return;
      }

      let directory: Dir | null = null;
      try {
        directory = await fileSystem.opendir(task.node.absolutePath);
        openDirectories.add(directory);
        throwIfNodeInactive(job, task.node);
        enqueue({type: 'read', node: task.node, directory});
      } catch (caught) {
        if (directory) {
          releaseDirectory(directory);
          await directory.close().catch(() => {});
        }
        if (isAbortError(caught)) {
          throw caught;
        }
        const error = toError(caught);
        if (task.node === job.root && job.oldParent && isNotFoundError(error)) {
          job.rootWasDeleted = true;
        } else if (removeDeletedRefreshedRoot(job, task.node, error)) {
          job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
          return;
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
      throwIfNodeInactive(job, task.node);

      if (!dirent) {
        releaseDirectory(task.directory);
        await task.directory.close().catch(() => {});
        throwIfNodeInactive(job, task.node);
        task.node.entriesRead = true;
        job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
        maybeCompleteNode(job, task.node);
        scheduleNotification();
        return;
      }

      const directoryPath = task.directory.path;
      const absolutePath = directoryPath.endsWith(sep)
        ? directoryPath + dirent.name
        : directoryPath + sep + dirent.name;
      const childKey = pathKeyForAbsolutePath(absolutePath);
      if (!ignoredPaths.has(childKey)) {
        task.node.pendingChildren += 1;
        enqueue({type: 'stat', absolutePath, pathKey: childKey, parent: task.node});
      }
      enqueue(task);
    } catch (caught) {
      releaseDirectory(task.directory);
      await task.directory.close().catch(() => {});
      if (isAbortError(caught)) {
        throw caught;
      }
      const error = toError(caught);
      if (task.node === job.root && job.oldParent && isNotFoundError(error)) {
        job.rootWasDeleted = true;
      } else if (removeDeletedRefreshedRoot(job, task.node, error)) {
        job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
        return;
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
    // A listed entry can be ignored before or while it is stat-ed.
    const skipIfIgnored = (): boolean => {
      if (task.node || !ignoredPaths.has(task.pathKey)) {
        return false;
      }
      if (task.parent) {
        childFinished(job, task.parent);
      }
      return true;
    };
    if (skipIfIgnored()) {
      return;
    }

    let stats: FileSystemStats;
    try {
      stats = await fileSystem.lstat(task.absolutePath);
      throwIfNodeInactive(job, task.node ?? task.parent);
      if (skipIfIgnored()) {
        return;
      }
    } catch (caught) {
      if (isAbortError(caught)) {
        throw caught;
      }
      if (skipIfIgnored()) {
        return;
      }

      const error = toError(caught);
      const pathKey = task.pathKey;
      if (task.node === job.root && job.oldParent && isNotFoundError(error)) {
        job.rootWasDeleted = true;
        task.node.isComplete = true;
      } else if (task.node && removeDeletedRefreshedRoot(job, task.node, error)) {
        return;
      } else {
        recordErrorAtPath(job, pathKey, error);
      }
      if (task.node === job.root && !job.rootWasDeleted) {
        job.fatalError = error;
        task.node.error = error;
        task.node.isComplete = true;
      } else if (!task.node && task.parent) {
        childFinished(job, task.parent);
      } else if (task.node && job.refreshedRoots.has(task.node)) {
        task.node.error = error;
        task.node.isComplete = true;
        job.refreshedRoots.delete(task.node);
        if (task.node.parent) {
          childFinished(job, task.node.parent);
        }
      }
      return;
    }

    const isDirectory = stats.isDirectory();
    const ownSize = sizeOnDisk(stats);
    const node: MutableFileInfo =
      task.node ??
      (isDirectory
        ? new DirectoryInfoNode(task.pathKey, task.parent!)
        : new CompletedFileInfoNode(task.pathKey, ownSize));

    if (task.node) {
      setNodeType(node, isDirectory);
      node.size = ownSize;
      node.entriesRead = !isDirectory;
      node.isComplete = !isDirectory;
      node.error = null;
    } else if (isDirectory) {
      node.size = ownSize;
    }

    const parent = task.node ? node.parent : task.parent;
    if (!task.node && parent) {
      if (parent.children === emptyChildren) {
        parent.children = [];
      }
      parent.children.push(node);
      addSubtreeToIndex(node);
    }

    addSizeToAncestors(parent, ownSize);

    if (isDirectory) {
      job.pendingDirectories += 1;
      enqueue({type: 'open', node});
    } else if (node !== job.root && parent) {
      job.refreshedRoots.delete(node);
      childFinished(job, parent);
    }

    scheduleNotification();
  }

  function maybeCompleteNode(job: ScanJob, node: MutableFileInfo): void {
    if (node.isComplete || !node.entriesRead || node.pendingChildren !== 0) {
      return;
    }

    node.children = node.children.length ? node.children.slice() : emptyChildren;
    node.isComplete = true;
    job.refreshedRoots.delete(node);
    if (node !== job.root && node.parent) {
      childFinished(job, node.parent);
    }
  }

  function removeDeletedRefreshedRoot(
    job: ScanJob,
    node: MutableFileInfo,
    error: Error,
  ): boolean {
    const parent = node.parent;
    if (!parent || !job.refreshedRoots.has(node) || !isNotFoundError(error)) {
      return false;
    }

    removeSubtreeFromIndex(node);
    parent.children = parent.children.filter(child => child !== node);
    addSizeToAncestors(parent, -node.size);
    job.refreshedRoots.delete(node);
    childFinished(job, parent);
    scheduleNotification();
    return true;
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
    job.completedAt = clock.now();

    const wasAborted =
      !job.isDiscarded && (job.controller.signal.aborted || activeJob !== job);
    if (job.isDiscarded) {
      restoreJobAncestors(job);
      lastOperationErrors = [];
    } else if (wasAborted || (job.fatalError && job.oldRoot)) {
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
      // A superseded job keeps the pause for its replacement; abort/ignore clear it explicitly.
      if (!wasAborted) {
        isPaused = false;
      }
    }

    notifyIdleWaiters(job);
    job.resolveDone();
    emitNow();
  }

  function notifyIdleWaiters(job: ScanJob): void {
    const waiters = job.idleWaiters;
    job.idleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  function pauseScan(): Promise<void> {
    const job = activeJob;
    if (!job || job.isSettled) {
      return Promise.resolve();
    }

    if (!isPaused) {
      isPaused = true;
      emitNow();
    }
    if (job.activeTasks === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => job.idleWaiters.push(resolve));
  }

  function resumeScan(): void {
    if (!isPaused) {
      return;
    }

    isPaused = false;
    if (activeJob) {
      // The pause was cancelled, so there is no checkpoint left to wait for.
      notifyIdleWaiters(activeJob);
      activeJob.dispatch?.();
    }
    emitNow();
  }

  function commitJob(job: ScanJob, pathKey: string): void {
    restoreJobAncestors(job);

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
    restoreJobAncestors(job);

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
      restoreJobAncestors(job);
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
    isPaused = false;
    completedAt = clock.now();
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

    // Ignoring prunes the entry and its descendants; the rest of an active scan continues.
    // Entries not yet listed are skipped when they are read, and queued or in-flight work
    // under a removed node is dropped because the node is no longer indexed.
    ignoredPaths.add(pathKey);
    const isOutsideIgnored = (error: DiskUsageError) =>
      !isSameOrDescendantPath(error.path, pathKey);
    committedErrors = committedErrors.filter(isOutsideIgnored);
    lastOperationErrors = lastOperationErrors.filter(isOutsideIgnored);

    const job = activeJob;
    if (job) {
      job.errors = job.errors.filter(isOutsideIgnored);
      if (!job.isSettled && isSameOrDescendantPath(pathKeyForNode(job.root), pathKey)) {
        // Everything this job was scanning is ignored, so there is nothing to restore.
        job.isDiscarded = true;
        job.oldRoot = null;
        job.controller.abort();
      }
    }

    const info = files.get(pathKey);
    if (info) {
      removeIgnoredNode(info, job);
    }
    job?.dispatch?.();
    emitNow();
  }

  function removeIgnoredNode(info: MutableFileInfo, job: ScanJob | null): void {
    const parent = info.parent;
    if (job) {
      job.pendingDirectories = Math.max(
        0,
        job.pendingDirectories - countPendingDirectories(info),
      );
      job.refreshedRoots.delete(info);
    }
    removeSubtreeFromIndex(info);
    if (!parent) {
      return;
    }

    parent.children = parent.children.filter(child => child !== info);
    for (let ancestor: MutableFileInfo | null = parent; ancestor; ancestor = ancestor.parent) {
      ancestor.size -= info.size;
    }

    // An incomplete child is counted in its parent's pending children, except for a job root.
    if (!info.isComplete && !job?.isDiscarded) {
      const parentIsInJob =
        job && isSameOrDescendantPath(pathKeyForNode(parent), pathKeyForNode(job.root));
      if (parentIsInJob) {
        childFinished(job, parent);
      } else {
        parent.pendingChildren = Math.max(0, parent.pendingChildren - 1);
      }
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

  function pathKeyForAbsolutePath(absolutePath: string): string {
    const relativePath = relative(rootAbsolutePath, absolutePath);
    return relativePath || '.';
  }

  function pathKeyForNode(node: MutableFileInfo): string {
    return node.path === rootAbsolutePath ? '.' : node.path;
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
      isPaused: isPaused && activeJob !== null,
      startedAt,
      completedAt: elapsedCompletedAt,
      elapsedMs: (elapsedCompletedAt ?? clock.now()) - startedAt,
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
    const key = pathKeyForNode(node);
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
    const key = pathKeyForNode(node);
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

  function countPendingDirectories(node: MutableFileInfo): number {
    let count = node.isDirectory && !node.entriesRead ? 1 : 0;
    for (const child of node.children) {
      count += countPendingDirectories(child);
    }
    return count;
  }

  function restoreJobAncestors(job: ScanJob): void {
    for (const [ancestor, wasComplete] of job.ancestorCompletion) {
      ancestor.isComplete = wasComplete;
    }
  }

  function markAncestorsIncomplete(node: MutableFileInfo | null): void {
    for (let current = node; current; current = current.parent) {
      current.isComplete = false;
    }
  }

  function recordError(job: ScanJob, info: MutableFileInfo, error: Error): void {
    info.error = error;
    recordErrorAtPath(job, pathKeyForNode(info), error);
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

  function isNodeActive(job: ScanJob, node: MutableFileInfo): boolean {
    return (
      !job.controller.signal.aborted &&
      activeJob === job &&
      files.get(pathKeyForNode(node)) === node
    );
  }

  function throwIfNodeInactive(job: ScanJob, node: MutableFileInfo | null): void {
    throwIfJobInactive(job);
    if (node && files.get(pathKeyForNode(node)) !== node) {
      throw new TraversalAbortedError();
    }
  }

  return {
    getReport,
    subscribe,
    refresh: refreshPath,
    ignore: ignorePath,
    abort: abortScan,
    pause: pauseScan,
    resume: resumeScan,
    wait: waitForCurrentRun,
  };
}

export function analyzeDiskUsage(
  rootPath: string,
  options?: DiskUsageScannerOptions,
): () => ProgressReport {
  const scanner = createDiskUsageScanner(rootPath, options);
  return scanner.getReport;
}

/**
 * Select directories by the space they account for beyond their largest child directory.
 * This prevents a single large subtree from occupying the list once for every ancestor,
 * while still allowing branching ancestors to rank for the other space they contain.
 */
export interface LargestCandidates {
  directories: [string, FileInfo][];
  files: [string, FileInfo][];
}

export function largestCandidates(
  progress: ProgressReport,
  count: number,
): LargestCandidates {
  return selectLargestCandidates(progress, count, true, true);
}

export function largestDirectoryCandidates(
  progress: ProgressReport,
  count: number,
): [string, FileInfo][] {
  return selectLargestCandidates(progress, count, true, false).directories;
}

export function largestFileCandidates(
  progress: ProgressReport,
  count: number,
): [string, FileInfo][] {
  return selectLargestCandidates(progress, count, false, true).files;
}

function selectLargestCandidates(
  progress: ProgressReport,
  count: number,
  includeDirectories: boolean,
  includeFiles: boolean,
): LargestCandidates {
  const limit = Math.max(0, count);
  const directories: {path: string; info: FileInfo; selectionSize: number}[] = [];
  const files: [string, FileInfo][] = [];
  if (limit === 0) {
    return {directories: [], files};
  }

  progress.files.forEach((info, path) => {
    if (path === '.') {
      return;
    }

    if (info.isDirectory) {
      if (!includeDirectories) {
        return;
      }
      let largestChildSize = 0;
      for (const child of info.children) {
        if (child.isDirectory && child.size > largestChildSize) {
          largestChildSize = child.size;
        }
      }
      const selectionSize = Math.max(0, info.size - largestChildSize);
      if (
        selectionSize === 0 ||
        (directories.length === limit &&
          compareDirectoryCandidate(
            directories[limit - 1].path,
            directories[limit - 1].info,
            directories[limit - 1].selectionSize,
            path,
            info,
            selectionSize,
          ) <= 0)
      ) {
        return;
      }

      let index = 0;
      while (
        index < directories.length &&
        compareDirectoryCandidate(
          directories[index].path,
          directories[index].info,
          directories[index].selectionSize,
          path,
          info,
          selectionSize,
        ) <= 0
      ) {
        index += 1;
      }
      if (index < limit) {
        directories.splice(index, 0, {path, info, selectionSize});
        if (directories.length > limit) {
          directories.pop();
        }
      }
    } else if (
      includeFiles &&
      (files.length < limit ||
        compareFileCandidate(files[limit - 1][0], files[limit - 1][1], path, info) > 0)
    ) {
      let index = 0;
      while (
        index < files.length &&
        compareFileCandidate(files[index][0], files[index][1], path, info) <= 0
      ) {
        index += 1;
      }
      if (index < limit) {
        files.splice(index, 0, [path, info]);
        if (files.length > limit) {
          files.pop();
        }
      }
    }
  });

  return {
    // Selection uses the non-redundant size, but the report remains ordered by total size.
    directories: directories
      .sort((a, b) => b.info.size - a.info.size || a.path.localeCompare(b.path))
      .map(({path, info}) => [path, info]),
    files,
  };
}

function compareDirectoryCandidate(
  aPath: string,
  aInfo: FileInfo,
  aSelectionSize: number,
  bPath: string,
  bInfo: FileInfo,
  bSelectionSize: number,
): number {
  return (
    bSelectionSize - aSelectionSize ||
    bInfo.size - aInfo.size ||
    aPath.localeCompare(bPath)
  );
}

function compareFileCandidate(
  aPath: string,
  aInfo: FileInfo,
  bPath: string,
  bInfo: FileInfo,
): number {
  return bInfo.size - aInfo.size || aPath.localeCompare(bPath);
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

function sizeOnDisk(stats: FileSystemStats): number {
  const blocks = stats.blocks;
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
