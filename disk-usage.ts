import {Buffer} from 'node:buffer';
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {systemClock, type Clock} from './clock.js';
import {
  ALIAS,
  COMPLETE,
  DETACHED,
  DIRECTORY,
  DirectoryIdentityTable,
  ENTRIES_READ,
  EntryStore,
  HAS_ERROR,
  IDENTITY_KEEP,
  IDENTITY_MATCH,
  IDENTITY_STALE,
  NONE,
  readDirectoryIdentity,
  type IdentityClassification,
} from './entry-store.js';
import {
  nodeFileSystem,
  type FileSystem,
  type FileSystemDirectory,
  type FileSystemStats,
} from './filesystem.js';

type Dir = FileSystemDirectory;

/**
 * A view of one scanned entry. Views are created on demand and read the scanner's compact
 * storage, so sizes and completion reflect the latest scan state. A view of an entry that has
 * since been removed reports no size and no children.
 */
export interface FileInfo {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  isDirectory: boolean;
  isComplete: boolean;
  error: Error | null;
  /**
   * For a directory reachable through another path that was already counted (the same device
   * and inode, e.g. a macOS firmlink), that path relative to the scan root. Its contents are
   * not scanned or counted again. `null` for every other entry.
   */
  aliasOf: string | null;
  /** Number of direct children, without creating a view for each. */
  childCount: number;
  children: FileInfo[];
  refresh(): Promise<void>;
  recalculate(): void;
  abort(): void;
  ignore(): void;
}

/** Looks up scanned entries by path relative to the scan root (`.` is the root). */
export interface FileIndex extends Iterable<[string, FileInfo]> {
  readonly size: number;
  get(path: string): FileInfo | undefined;
  has(path: string): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<FileInfo>;
  entries(): IterableIterator<[string, FileInfo]>;
  forEach(callback: (info: FileInfo, path: string) => void): void;
}

export interface DiskUsageError {
  path: string;
  message: string;
  code?: string;
}

export interface LargestCandidates {
  directories: [string, FileInfo][];
  files: [string, FileInfo][];
}

export interface ProgressReport extends FileInfo {
  rootPath: string;
  files: FileIndex;
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
  /** See `largestCandidates`. */
  largest(count: number): LargestCandidates;
}

export interface DiskUsageMemoryUsage {
  /** Entries currently stored, including a previous subtree kept while it is refreshed. */
  entries: number;
  entryCapacity: number;
  entryBytes: number;
  nameBytes: number;
  nameCapacityBytes: number;
  identityBytes: number;
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
  getMemoryUsage(): DiskUsageMemoryUsage;
}

export interface DiskUsageScannerOptions {
  fileSystem?: FileSystem;
  clock?: Clock;
}

interface ScanJob {
  id: number;
  /** The path this job scans, relative to the scanner root. */
  pathKey: string;
  controller: AbortController;
  root: number;
  rootGeneration: number;
  /** The previous subtree, kept aside so an aborted or failed refresh can restore it. */
  oldRoot: number;
  oldParent: number;
  /** Completion of the job root's ancestors when it started: id → generation * 2 + complete. */
  ancestorCompletion: Map<number, number>;
  refreshedRoots: Set<number>;
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

// Tasks refer to entries by `(id, generation)`, so work for a removed entry is detected even
// after its slot is reused. Only the bounded set of queued tasks carries path strings.
type ScanTask =
  | {
      type: 'stat';
      absolutePath: string;
      /** Basename of a newly listed entry. */
      name: string;
      parent: number;
      parentGeneration: number;
      /** An existing entry being re-stat-ed (a refresh root), or NONE for a new entry. */
      node: number;
      nodeGeneration: number;
    }
  | {type: 'open'; node: number; generation: number}
  | {type: 'read'; node: number; generation: number; directory: Dir};

interface Candidate {
  id: number;
  generation: number;
  size: number;
  selectionSize: number;
  path: string | null;
}

class TraversalAbortedError extends Error {
  constructor() {
    super('Disk usage scan aborted');
    this.name = 'AbortError';
  }
}

const IO_CONCURRENCY = 8;
const MAX_OPEN_DIRECTORIES = 128;
const NOTIFICATION_INTERVAL_MS = 50;
/** While scanning, largest-entry rankings are recomputed at most this often. */
const LARGEST_REFRESH_MS = 1000;

export function createDiskUsageScanner(
  rootPath: string,
  options: DiskUsageScannerOptions = {},
): DiskUsageScanner {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const clock = options.clock ?? systemClock;
  const rootAbsolutePath = resolve(rootPath);
  const rootName = basename(rootAbsolutePath);
  const ignoredPaths = new Set<string>();
  const listeners = new Set<() => void>();

  const store = new EntryStore();
  const identities = new DirectoryIdentityTable(classifyIdentityOwner);
  const identityScratch = new Uint32Array(4);
  // Sparse state: only directories still being scanned, failed entries, and aliases.
  const pendingChildren = new Map<number, number>();
  const nodeErrors = new Map<number, DiskUsageError>();
  // Alias entry → the directory identity it shares, resolved to the current owner on demand.
  const aliasIdentities = new Map<number, Uint32Array>();

  let visibleRoot = store.allocate('', NONE, DIRECTORY, 0);
  let activeJob: ScanJob | null = null;
  let operationId = 0;
  let refreshRequestId = 0;
  let filesScanned = 0;
  let directoriesScanned = 1;
  let committedErrors: DiskUsageError[] = [];
  let lastOperationErrors: DiskUsageError[] = [];
  let isAborted = false;
  // Pausing belongs to the scanner rather than a job, so a refresh requested while paused
  // replaces the work but stays paused.
  let isPaused = false;
  let startedAt = clock.now();
  let completedAt: number | null = null;
  let notificationTimer: unknown = null;
  // Incremented whenever entries are added to or removed from the tree by something other
  // than the steady progress of a scan; invalidates cached rankings.
  let structureVersion = 0;
  let largestCache: {
    limit: number;
    version: number;
    computedAt: number;
    wasScanning: boolean;
    directories: Candidate[];
    files: Candidate[];
  } | null = null;

  void startScan('.');

  // Entry helpers

  function hasFlags(id: number, mask: number): boolean {
    return (store.flags(id) & mask) !== 0;
  }

  function isDirectoryEntry(id: number): boolean {
    return hasFlags(id, DIRECTORY);
  }

  function isLiveRef(id: number, generation: number): boolean {
    return id === NONE || store.isLive(id, generation);
  }

  function pathKeyFor(id: number): string {
    if (store.parent(id) === NONE) {
      return '.';
    }
    const names: string[] = [];
    for (let current = id; store.parent(current) !== NONE; current = store.parent(current)) {
      names.push(store.name(current));
    }
    names.reverse();
    return names.join(sep);
  }

  function absolutePathForKey(pathKey: string): string {
    if (pathKey === '.') {
      return rootAbsolutePath;
    }
    return rootAbsolutePath.endsWith(sep)
      ? rootAbsolutePath + pathKey
      : rootAbsolutePath + sep + pathKey;
  }

  function absolutePathFor(id: number): string {
    return absolutePathForKey(pathKeyFor(id));
  }

  /** Finds the entry linked into the visible tree at a path key, or NONE. */
  function resolvePathKey(pathKey: string): number {
    if (pathKey === '.') {
      return visibleRoot;
    }
    let id = visibleRoot;
    for (const segment of pathKey.split(sep)) {
      if (!segment || segment === '.' || segment === '..') {
        return NONE;
      }
      id = store.findChild(id, Buffer.from(segment, 'utf8'));
      if (id === NONE) {
        return NONE;
      }
    }
    return id;
  }

  function isAttached(id: number): boolean {
    for (let current = id; ; current = store.parent(current)) {
      if (hasFlags(current, DETACHED)) {
        return false;
      }
      if (store.parent(current) === NONE) {
        return current === visibleRoot;
      }
    }
  }

  function classifyIdentityOwner(id: number, generation: number): IdentityClassification {
    if (
      !store.isLive(id, generation) ||
      (store.flags(id) & (DIRECTORY | ALIAS)) !== DIRECTORY
    ) {
      return IDENTITY_STALE;
    }
    return isAttached(id) ? IDENTITY_MATCH : IDENTITY_KEEP;
  }

  /**
   * Registers a directory's identity. Returns the entry that already owns it, in which case
   * this directory is an alias of that entry and must not be scanned again.
   */
  function claimDirectoryIdentity(stats: FileSystemStats, id: number): number {
    if (!readDirectoryIdentity(stats, identityScratch)) {
      return NONE;
    }
    const owner = identities.find(identityScratch);
    if (owner !== NONE && owner !== id) {
      return owner;
    }
    if (owner === NONE) {
      identities.insert(identityScratch, id, store.generation(id));
    }
    return NONE;
  }

  function countEntries(root: number, sign: 1 | -1): void {
    store.forEachInSubtree(root, id => {
      if (isDirectoryEntry(id)) {
        directoriesScanned += sign;
      } else {
        filesScanned += sign;
      }
    });
  }

  /** Recycles an unlinked subtree and its sparse state. */
  function releaseTree(root: number, wasAttached: boolean): void {
    const job = activeJob;
    store.releaseSubtree(root, id => {
      const flags = store.flags(id);
      if (wasAttached) {
        if (flags & DIRECTORY) {
          directoriesScanned -= 1;
        } else {
          filesScanned -= 1;
        }
      }
      if (flags & HAS_ERROR) {
        nodeErrors.delete(id);
      }
      if (flags & ALIAS) {
        aliasIdentities.delete(id);
      }
      pendingChildren.delete(id);
      job?.refreshedRoots.delete(id);
    });
    structureVersion += 1;
  }

  function pendingChildrenOf(id: number): number {
    return pendingChildren.get(id) ?? 0;
  }

  function addPendingChildren(id: number, delta: number): void {
    const next = Math.max(0, pendingChildrenOf(id) + delta);
    if (next) {
      pendingChildren.set(id, next);
    } else {
      pendingChildren.delete(id);
    }
  }

  function setNodeError(id: number, report: DiskUsageError): void {
    nodeErrors.set(id, report);
    store.addFlags(id, HAS_ERROR);
  }

  function clearNodeState(id: number): void {
    if (hasFlags(id, HAS_ERROR)) {
      nodeErrors.delete(id);
    }
    if (hasFlags(id, ALIAS)) {
      aliasIdentities.delete(id);
    }
    store.clearFlags(id, COMPLETE | ENTRIES_READ | HAS_ERROR | ALIAS);
  }

  // Notifications

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

  // Jobs

  function createJob(root: number, oldRoot: number, pathKey: string): ScanJob {
    let resolveDone = () => {};
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });
    const ancestorCompletion = new Map<number, number>();
    for (let ancestor = store.parent(root); ancestor !== NONE; ancestor = store.parent(ancestor)) {
      ancestorCompletion.set(
        ancestor,
        store.generation(ancestor) * 2 + (hasFlags(ancestor, COMPLETE) ? 1 : 0),
      );
    }

    return {
      id: ++operationId,
      pathKey,
      controller: new AbortController(),
      root,
      rootGeneration: store.generation(root),
      oldRoot,
      oldParent: oldRoot !== NONE ? store.parent(oldRoot) : NONE,
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

  function isJobRunning(job: ScanJob): boolean {
    return !job.isSettled && !job.controller.signal.aborted && activeJob === job;
  }

  async function startScan(requestedPathKey: string): Promise<void> {
    const requestId = ++refreshRequestId;
    const previousJob = activeJob;
    let pathKey = existingPathOrParent(requestedPathKey);

    if (previousJob && pathKey && isJobRunning(previousJob)) {
      const jobPath = previousJob.pathKey;
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

    const requested = resolvePathKey(pathKey) || visibleRoot;
    // Keep a partial subtree as the rollback point for a targeted refresh. Falling back to the
    // scanner root here makes a refresh button unexpectedly restart the entire tree.
    const canReplaceRequested = pathKey !== '.' || hasFlags(requested, COMPLETE);
    const oldRoot = canReplaceRequested ? requested : NONE;
    const scanPath = oldRoot !== NONE ? pathKey : '.';
    const replaced = oldRoot !== NONE ? oldRoot : visibleRoot;
    const replacedParent = store.parent(replaced);
    const staging = store.allocate(
      replacedParent === NONE ? '' : store.name(replaced),
      replacedParent,
      store.flags(replaced) & DIRECTORY,
      0,
    );
    const job = createJob(staging, oldRoot, scanPath);

    activeJob = job;
    isAborted = false;
    startedAt = job.startedAt;
    completedAt = null;
    lastOperationErrors = [];

    attachStagingTree(job, replaced);
    markAncestorsIncomplete(store.parent(staging));
    emitNow();

    runJob(job).catch(caught => {
      if (!isAbortError(caught)) {
        job.fatalError = toError(caught);
      }
    });

    await job.done;
  }

  function existingPathOrParent(pathKey: string): string | null {
    if (pathKey === '.' || resolvePathKey(pathKey) !== NONE) {
      return pathKey;
    }

    // A stale row can outlive its entry (for example, when an in-flight parent scan is
    // cancelled). Refresh its parent so the browser is reconciled with the filesystem.
    const parentPathKey = pathKeyForAbsolutePath(dirname(resolve(rootAbsolutePath, pathKey)));
    return parentPathKey !== pathKey && resolvePathKey(parentPathKey) !== NONE
      ? parentPathKey
      : null;
  }

  function restartSubtreeInJob(job: ScanJob, pathKey: string): boolean {
    const replaced = resolvePathKey(pathKey);
    const parent = replaced === NONE ? NONE : store.parent(replaced);
    if (parent === NONE || !job.enqueueTask || job.isSettled) {
      return false;
    }

    const wasComplete = hasFlags(replaced, COMPLETE);
    const replacedSize = store.size(replaced);
    job.pendingDirectories = Math.max(
      0,
      job.pendingDirectories - countPendingDirectories(replaced),
    );

    const staging = store.allocate(
      store.name(replaced),
      parent,
      store.flags(replaced) & DIRECTORY,
      0,
    );
    store.replaceChild(parent, replaced, staging);
    releaseTree(replaced, true);
    if (isDirectoryEntry(staging)) {
      directoriesScanned += 1;
    } else {
      filesScanned += 1;
    }
    addSizeToAncestors(parent, -replacedSize);
    if (wasComplete) {
      addPendingChildren(parent, 1);
    }
    job.refreshedRoots.add(staging);
    job.errors = job.errors.filter(error => !isSameOrDescendantPath(error.path, pathKey));
    lastOperationErrors = [];
    isAborted = false;
    completedAt = null;
    job.enqueueTask({
      type: 'stat',
      absolutePath: absolutePathForKey(pathKey),
      name: '',
      parent,
      parentGeneration: store.generation(parent),
      node: staging,
      nodeGeneration: store.generation(staging),
    });
    return true;
  }

  function attachStagingTree(job: ScanJob, replaced: number): void {
    const parent = store.parent(replaced);
    countEntries(replaced, -1);

    if (parent !== NONE) {
      store.replaceChild(parent, replaced, job.root);
      addSizeToAncestors(parent, -store.size(replaced));
    } else {
      visibleRoot = job.root;
    }
    if (isDirectoryEntry(job.root)) {
      directoriesScanned += 1;
    } else {
      filesScanned += 1;
    }

    if (job.oldRoot === replaced) {
      store.addFlags(replaced, DETACHED);
    } else {
      // A partial initial scan has no complete result worth restoring.
      releaseTree(replaced, false);
    }
    structureVersion += 1;
  }

  async function runJob(job: ScanJob): Promise<void> {
    const rootParent = store.parent(job.root);
    const tasks: ScanTask[] = [
      {
        type: 'stat',
        absolutePath: absolutePathForKey(job.pathKey),
        name: '',
        parent: rootParent,
        parentGeneration: rootParent === NONE ? 0 : store.generation(rootParent),
        node: job.root,
        nodeGeneration: job.rootGeneration,
      },
    ];
    const openDirectories = new Set<Dir>();
    // Directories waiting for a free handle, packed as `id * 256 + generation`.
    const deferredOpens: number[] = [];
    let deferredOpenIndex = 0;
    let taskIndex = 0;

    const enqueue = (task: ScanTask): void => {
      if (!job.controller.signal.aborted && activeJob === job) {
        tasks.push(task);
      }
    };

    const deferOpen = (node: number, generation: number): void => {
      deferredOpens.push(node * 256 + generation);
    };

    const enqueueNextDeferredOpenTask = (): boolean => {
      if (
        job.controller.signal.aborted ||
        activeJob !== job ||
        openDirectories.size >= MAX_OPEN_DIRECTORIES ||
        deferredOpenIndex >= deferredOpens.length
      ) {
        return false;
      }

      const packed = deferredOpens[deferredOpenIndex++];
      // Keep the queue FIFO without retaining an ever-growing consumed prefix.
      if (deferredOpenIndex > 1024 && deferredOpenIndex * 2 > deferredOpens.length) {
        deferredOpens.splice(0, deferredOpenIndex);
        deferredOpenIndex = 0;
      }
      enqueue({type: 'open', node: Math.floor(packed / 256), generation: packed % 256});
      return true;
    };

    const releaseDirectory = (directory: Dir): void => {
      openDirectories.delete(directory);
      enqueueNextDeferredOpenTask();
    };

    const finishIfIdle = async (): Promise<void> => {
      if (job.isSettled || job.activeTasks !== 0 || taskIndex < tasks.length) {
        return;
      }
      if (enqueueNextDeferredOpenTask()) {
        pump();
        return;
      }

      for (const directory of openDirectories) {
        await directory.close().catch(() => {});
      }
      openDirectories.clear();
      settleJob(job);
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

        executeTask(job, task, enqueue, openDirectories, deferOpen, releaseDirectory)
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
      deferredOpenIndex = deferredOpens.length;
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
    deferOpen: (node: number, generation: number) => void,
    releaseDirectory: (directory: Dir) => void,
  ): Promise<void> {
    if (task.type === 'read' && !isNodeActive(job, task.node, task.generation)) {
      // The directory was ignored or replaced while this read was queued; release its handle.
      releaseDirectory(task.directory);
      await task.directory.close().catch(() => {});
      throw new TraversalAbortedError();
    }

    if (task.type === 'stat') {
      throwIfStatTaskInactive(job, task);
      await executeStatTask(job, task, enqueue);
      return;
    }

    throwIfNodeInactive(job, task.node, task.generation);

    if (task.type === 'open') {
      if (openDirectories.size >= MAX_OPEN_DIRECTORIES) {
        deferOpen(task.node, task.generation);
        return;
      }

      let directory: Dir | null = null;
      try {
        directory = await fileSystem.opendir(absolutePathFor(task.node));
        openDirectories.add(directory);
        throwIfNodeInactive(job, task.node, task.generation);
        enqueue({type: 'read', node: task.node, generation: task.generation, directory});
      } catch (caught) {
        if (directory) {
          releaseDirectory(directory);
          await directory.close().catch(() => {});
        }
        if (isAbortError(caught)) {
          throw caught;
        }
        throwIfNodeInactive(job, task.node, task.generation);
        handleDirectoryFailure(job, task.node, toError(caught));
      }
      return;
    }

    try {
      const entry = await task.directory.read();
      throwIfNodeInactive(job, task.node, task.generation);

      if (!entry) {
        releaseDirectory(task.directory);
        await task.directory.close().catch(() => {});
        throwIfNodeInactive(job, task.node, task.generation);
        store.addFlags(task.node, ENTRIES_READ);
        job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
        maybeCompleteNode(job, task.node);
        scheduleNotification();
        return;
      }

      const directoryPath = task.directory.path;
      const absolutePath = directoryPath.endsWith(sep)
        ? directoryPath + entry.name
        : directoryPath + sep + entry.name;
      if (!ignoredPaths.size || !ignoredPaths.has(pathKeyForAbsolutePath(absolutePath))) {
        addPendingChildren(task.node, 1);
        enqueue({
          type: 'stat',
          absolutePath,
          name: entry.name,
          parent: task.node,
          parentGeneration: task.generation,
          node: NONE,
          nodeGeneration: 0,
        });
      }
      enqueue(task);
    } catch (caught) {
      releaseDirectory(task.directory);
      await task.directory.close().catch(() => {});
      if (isAbortError(caught)) {
        throw caught;
      }
      throwIfNodeInactive(job, task.node, task.generation);
      handleDirectoryFailure(job, task.node, toError(caught));
    }
  }

  function handleDirectoryFailure(job: ScanJob, node: number, error: Error): void {
    if (node === job.root && job.oldParent !== NONE && isNotFoundError(error)) {
      job.rootWasDeleted = true;
    } else if (removeDeletedRefreshedRoot(job, node, error)) {
      job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
      return;
    } else {
      recordError(job, node, error);
    }
    store.addFlags(node, ENTRIES_READ);
    job.pendingDirectories = Math.max(0, job.pendingDirectories - 1);
    maybeCompleteNode(job, node);
  }

  async function executeStatTask(
    job: ScanJob,
    task: Extract<ScanTask, {type: 'stat'}>,
    enqueue: (task: ScanTask) => void,
  ): Promise<void> {
    // A listed entry can be ignored before or while it is stat-ed.
    const skipIfIgnored = (): boolean => {
      if (
        task.node !== NONE ||
        !ignoredPaths.size ||
        !ignoredPaths.has(pathKeyForAbsolutePath(task.absolutePath))
      ) {
        return false;
      }
      childFinished(job, task.parent);
      return true;
    };
    if (skipIfIgnored()) {
      return;
    }

    let stats: FileSystemStats;
    try {
      stats = await fileSystem.lstat(task.absolutePath);
      throwIfStatTaskInactive(job, task);
      if (skipIfIgnored()) {
        return;
      }
    } catch (caught) {
      if (isAbortError(caught)) {
        throw caught;
      }
      throwIfStatTaskInactive(job, task);
      if (!skipIfIgnored()) {
        handleStatFailure(job, task, toError(caught));
      }
      return;
    }

    const isDirectory = stats.isDirectory();
    const ownSize = sizeOnDisk(stats);
    let node = task.node;
    const parent = node !== NONE ? store.parent(node) : task.parent;

    if (node !== NONE) {
      setNodeType(node, isDirectory);
      clearNodeState(node);
      store.setSize(node, ownSize);
      if (!isDirectory) {
        store.addFlags(node, COMPLETE | ENTRIES_READ);
      }
    } else {
      node = store.allocate(
        task.name,
        parent,
        isDirectory ? DIRECTORY : COMPLETE | ENTRIES_READ,
        ownSize,
      );
      store.prependChild(parent, node);
      if (isDirectory) {
        directoriesScanned += 1;
      } else {
        filesScanned += 1;
      }
    }

    const aliasOf = isDirectory ? claimDirectoryIdentity(stats, node) : NONE;
    if (aliasOf !== NONE) {
      // The same directory is already counted elsewhere; record where, and do not descend.
      store.setSize(node, 0);
      store.addFlags(node, ALIAS | COMPLETE | ENTRIES_READ);
      aliasIdentities.set(node, identityScratch.slice());
    } else {
      addSizeToAncestors(parent, ownSize);
    }

    if (isDirectory && aliasOf === NONE) {
      job.pendingDirectories += 1;
      enqueue({type: 'open', node, generation: store.generation(node)});
    } else if (node !== job.root && parent !== NONE) {
      job.refreshedRoots.delete(node);
      childFinished(job, parent);
    }

    scheduleNotification();
  }

  function handleStatFailure(
    job: ScanJob,
    task: Extract<ScanTask, {type: 'stat'}>,
    error: Error,
  ): void {
    const node = task.node;
    let report: DiskUsageError | null = null;
    if (node === job.root && job.oldParent !== NONE && isNotFoundError(error)) {
      job.rootWasDeleted = true;
      store.addFlags(node, COMPLETE);
    } else if (node !== NONE && removeDeletedRefreshedRoot(job, node, error)) {
      return;
    } else {
      report = recordErrorAtPath(job, pathKeyForAbsolutePath(task.absolutePath), error);
    }

    if (node === job.root && !job.rootWasDeleted) {
      job.fatalError = error;
      if (report) {
        setNodeError(node, report);
      }
      store.addFlags(node, COMPLETE);
    } else if (node === NONE && task.parent !== NONE) {
      childFinished(job, task.parent);
    } else if (node !== NONE && job.refreshedRoots.has(node)) {
      if (report) {
        setNodeError(node, report);
      }
      store.addFlags(node, COMPLETE);
      job.refreshedRoots.delete(node);
      const parent = store.parent(node);
      if (parent !== NONE) {
        childFinished(job, parent);
      }
    }
  }

  function maybeCompleteNode(job: ScanJob, node: number): void {
    const flags = store.flags(node);
    if (flags & COMPLETE || !(flags & ENTRIES_READ) || pendingChildrenOf(node) !== 0) {
      return;
    }

    store.addFlags(node, COMPLETE);
    job.refreshedRoots.delete(node);
    const parent = store.parent(node);
    if (node !== job.root && parent !== NONE) {
      childFinished(job, parent);
    }
  }

  function removeDeletedRefreshedRoot(job: ScanJob, node: number, error: Error): boolean {
    const parent = store.parent(node);
    if (parent === NONE || !job.refreshedRoots.has(node) || !isNotFoundError(error)) {
      return false;
    }

    const size = store.size(node);
    store.unlinkChild(parent, node);
    releaseTree(node, true);
    addSizeToAncestors(parent, -size);
    job.refreshedRoots.delete(node);
    childFinished(job, parent);
    scheduleNotification();
    return true;
  }

  function childFinished(job: ScanJob, parent: number): void {
    addPendingChildren(parent, -1);
    maybeCompleteNode(job, parent);
  }

  function settleJob(job: ScanJob): void {
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
    } else if (wasAborted || (job.fatalError && job.oldRoot !== NONE)) {
      rollbackJob(job);
      lastOperationErrors = job.fatalError ? [...job.errors] : [];
    } else if (job.rootWasDeleted) {
      commitDeletedJob(job);
    } else {
      commitJob(job);
    }
    releaseOldRoot(job);

    if (activeJob === job) {
      activeJob = null;
      isAborted = wasAborted;
      completedAt = job.completedAt;
      // A superseded job keeps the pause for its replacement; abort/ignore clear it explicitly.
      if (!wasAborted) {
        isPaused = false;
      }
    }

    job.refreshedRoots.clear();
    job.ancestorCompletion.clear();
    structureVersion += 1;
    notifyIdleWaiters(job);
    job.resolveDone();
    emitNow();
  }

  function releaseOldRoot(job: ScanJob): void {
    if (job.oldRoot !== NONE) {
      releaseTree(job.oldRoot, false);
      job.oldRoot = NONE;
    }
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

  function commitJob(job: ScanJob): void {
    restoreJobAncestors(job);

    committedErrors = committedErrors.filter(
      error => !isSameOrDescendantPath(error.path, job.pathKey),
    );
    committedErrors.push(...job.errors);
    lastOperationErrors = [];
  }

  function commitDeletedJob(job: ScanJob): void {
    const parent = job.oldParent;
    if (parent === NONE) {
      // The scanner root cannot be removed from a parent tree. Root failures remain errors.
      rollbackJob(job);
      return;
    }

    if (store.isLive(job.root, job.rootGeneration)) {
      const size = store.size(job.root);
      const wasLinked = store.unlinkChild(parent, job.root);
      releaseTree(job.root, wasLinked);
      if (wasLinked) {
        addSizeToAncestors(parent, -size);
      }
    }
    restoreJobAncestors(job);

    committedErrors = committedErrors.filter(
      error => !isSameOrDescendantPath(error.path, job.pathKey),
    );
    lastOperationErrors = [];
  }

  function rollbackJob(job: ScanJob): void {
    const oldRoot = job.oldRoot;
    if (oldRoot === NONE) {
      // An initial scan has no previous complete tree to restore. Keep its partial result visible.
      return;
    }
    job.oldRoot = NONE;

    const staging = job.root;
    const stagingIsLive = store.isLive(staging, job.rootGeneration);
    store.clearFlags(oldRoot, DETACHED);
    if (job.oldParent !== NONE) {
      const wasLinked = stagingIsLive && store.replaceChild(job.oldParent, staging, oldRoot);
      if (!wasLinked) {
        store.prependChild(job.oldParent, oldRoot);
      }
      const stagingSize = wasLinked ? store.size(staging) : 0;
      if (stagingIsLive) {
        releaseTree(staging, wasLinked);
      }
      addSizeToAncestors(job.oldParent, store.size(oldRoot) - stagingSize);
      restoreJobAncestors(job);
    } else {
      visibleRoot = oldRoot;
      if (stagingIsLive) {
        releaseTree(staging, true);
      }
    }
    countEntries(oldRoot, 1);
  }

  function cancelJob(job: ScanJob, rollbackImmediately: boolean): void {
    if (job.isSettled) {
      return;
    }

    job.controller.abort();
    if (rollbackImmediately && job.oldRoot !== NONE && activeJob === job) {
      rollbackJob(job);
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
    // under a removed entry is dropped because its generation no longer matches.
    ignoredPaths.add(pathKey);
    const isOutsideIgnored = (error: DiskUsageError) =>
      !isSameOrDescendantPath(error.path, pathKey);
    committedErrors = committedErrors.filter(isOutsideIgnored);
    lastOperationErrors = lastOperationErrors.filter(isOutsideIgnored);

    const job = activeJob;
    if (job) {
      job.errors = job.errors.filter(isOutsideIgnored);
      if (!job.isSettled && isSameOrDescendantPath(job.pathKey, pathKey)) {
        // Everything this job was scanning is ignored, so there is nothing to restore.
        job.isDiscarded = true;
        releaseOldRoot(job);
        job.controller.abort();
      }
    }

    const info = resolvePathKey(pathKey);
    if (info !== NONE) {
      removeIgnoredNode(info, job);
    }
    job?.dispatch?.();
    emitNow();
  }

  function removeIgnoredNode(info: number, job: ScanJob | null): void {
    const parent = store.parent(info);
    if (parent === NONE) {
      return;
    }
    if (job) {
      job.pendingDirectories = Math.max(
        0,
        job.pendingDirectories - countPendingDirectories(info),
      );
    }

    const wasComplete = hasFlags(info, COMPLETE);
    const size = store.size(info);
    store.unlinkChild(parent, info);
    releaseTree(info, true);
    for (let ancestor = parent; ancestor !== NONE; ancestor = store.parent(ancestor)) {
      store.addSize(ancestor, -size);
    }

    // An incomplete child is counted in its parent's pending children, except for a job root.
    if (!wasComplete && !job?.isDiscarded) {
      const parentIsInJob =
        job !== null && isSameOrDescendantPath(pathKeyFor(parent), job.pathKey);
      if (parentIsInJob) {
        childFinished(job, parent);
      } else {
        addPendingChildren(parent, -1);
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

  // Views

  class EntryInfo implements FileInfo {
    private cachedName: string | undefined;
    private cachedPath: string | undefined;
    private cachedError: Error | null | undefined;
    private readonly isRoot: boolean;

    constructor(
      private readonly views: ReportViews,
      readonly id: number,
      readonly generation: number,
      /** The parent's path key, or the entry's own path key when `knownPath` is set. */
      private readonly pathHint: string | undefined,
      private readonly knownPath: boolean,
    ) {
      this.isRoot = store.parent(id) === NONE;
    }

    private get isLive(): boolean {
      return store.isLive(this.id, this.generation);
    }

    /** Path key relative to the scan root; `.` for the root. */
    get key(): string {
      return this.isRoot ? '.' : this.path;
    }

    get name(): string {
      if (this.cachedName === undefined) {
        this.cachedName = this.isRoot ? rootName : this.isLive ? store.name(this.id) : '';
      }
      return this.cachedName;
    }

    get path(): string {
      if (this.cachedPath === undefined) {
        if (this.isRoot) {
          this.cachedPath = rootAbsolutePath;
        } else if (this.knownPath && this.pathHint !== undefined) {
          this.cachedPath = this.pathHint;
        } else if (this.pathHint !== undefined) {
          this.cachedPath = this.pathHint === '.' ? this.name : this.pathHint + sep + this.name;
        } else {
          this.cachedPath = this.isLive ? pathKeyFor(this.id) : '';
        }
      }
      return this.cachedPath;
    }

    get absolutePath(): string {
      return this.isRoot ? rootAbsolutePath : absolutePathForKey(this.path);
    }

    get size(): number {
      return this.isLive ? store.size(this.id) : 0;
    }

    get isDirectory(): boolean {
      return this.isLive && isDirectoryEntry(this.id);
    }

    get isComplete(): boolean {
      return !this.isLive || hasFlags(this.id, COMPLETE);
    }

    get error(): Error | null {
      if (!this.isLive || !hasFlags(this.id, HAS_ERROR)) {
        return null;
      }
      if (this.cachedError === undefined) {
        const report = nodeErrors.get(this.id);
        this.cachedError = report ? toFileError(report) : null;
      }
      return this.cachedError;
    }

    get aliasOf(): string | null {
      if (!this.isLive || !hasFlags(this.id, ALIAS)) {
        return null;
      }
      const identity = aliasIdentities.get(this.id);
      const owner = identity ? identities.find(identity) : NONE;
      return owner === NONE ? null : pathKeyFor(owner);
    }

    get childCount(): number {
      if (!this.isLive) {
        return 0;
      }
      let count = 0;
      for (
        let child = store.firstChild(this.id);
        child !== NONE;
        child = store.nextSibling(child)
      ) {
        count += 1;
      }
      return count;
    }

    get children(): FileInfo[] {
      if (!this.isLive || !isDirectoryEntry(this.id)) {
        return [];
      }
      const key = this.key;
      const children: FileInfo[] = [];
      for (
        let child = store.firstChild(this.id);
        child !== NONE;
        child = store.nextSibling(child)
      ) {
        children.push(this.views.viewFor(child, key, false));
      }
      return children;
    }

    refresh(): Promise<void> {
      if (!this.isRoot && !this.path) {
        return Promise.resolve();
      }
      return refreshPath(this.absolutePath);
    }

    recalculate(): void {
      // Sizes are updated incrementally by the active subtree scan.
    }

    abort(): void {
      abortScan();
    }

    ignore(): void {
      if (!this.isRoot && this.path) {
        ignorePath(this.absolutePath);
      }
    }
  }

  /** Per-report view cache, so a report returns the same view for the same entry. */
  class ReportViews {
    private readonly views = new Map<number, EntryInfo>();

    viewFor(id: number, pathHint?: string, knownPath = false): EntryInfo {
      const generation = store.generation(id);
      let view = this.views.get(id);
      if (!view || view.generation !== generation) {
        view = new EntryInfo(this, id, generation, pathHint, knownPath);
        this.views.set(id, view);
      }
      return view;
    }
  }

  class EntryIndex implements FileIndex {
    constructor(private readonly views: ReportViews) {}

    get size(): number {
      return filesScanned + directoriesScanned;
    }

    get(path: string): FileInfo | undefined {
      const id = resolvePathKey(path);
      if (id === NONE) {
        return undefined;
      }
      return path === '.' ? this.views.viewFor(id) : this.views.viewFor(id, path, true);
    }

    has(path: string): boolean {
      return resolvePathKey(path) !== NONE;
    }

    *entries(): IterableIterator<[string, FileInfo]> {
      const stack: EntryInfo[] = [this.views.viewFor(visibleRoot)];
      while (stack.length) {
        const view = stack.pop()!;
        yield [view.key, view];
        const children = view.children as EntryInfo[];
        for (let index = children.length - 1; index >= 0; index--) {
          stack.push(children[index]);
        }
      }
    }

    *keys(): IterableIterator<string> {
      for (const [key] of this.entries()) {
        yield key;
      }
    }

    *values(): IterableIterator<FileInfo> {
      for (const [, info] of this.entries()) {
        yield info;
      }
    }

    [Symbol.iterator](): IterableIterator<[string, FileInfo]> {
      return this.entries();
    }

    forEach(callback: (info: FileInfo, path: string) => void): void {
      for (const [key, info] of this.entries()) {
        callback(info, key);
      }
    }
  }

  function getReport(): ProgressReport {
    const errors = [...committedErrors, ...lastOperationErrors];
    if (activeJob) {
      errors.push(...activeJob.errors);
    }
    const elapsedCompletedAt = completedAt;
    const views = new ReportViews();
    const root = visibleRoot;

    return {
      path: rootAbsolutePath,
      absolutePath: rootAbsolutePath,
      name: rootName,
      size: store.size(root),
      isDirectory: isDirectoryEntry(root),
      isComplete: !activeJob && hasFlags(root, COMPLETE),
      aliasOf: null,
      get childCount() {
        return views.viewFor(root).childCount;
      },
      get children() {
        return views.viewFor(root).children;
      },
      refresh: () => refreshPath('.'),
      recalculate() {},
      abort: abortScan,
      ignore() {},
      rootPath: rootAbsolutePath,
      files: new EntryIndex(views),
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
      largest: count => largestEntries(views, count),
    };
  }

  // Rankings

  function largestEntries(views: ReportViews, count: number): LargestCandidates {
    const limit = Math.max(0, Math.floor(count));
    if (limit === 0) {
      return {directories: [], files: []};
    }

    const now = clock.now();
    const isScanning = activeJob !== null;
    const cached = largestCache;
    const isFresh =
      cached !== null &&
      cached.limit === limit &&
      cached.version === structureVersion &&
      (isScanning
        ? now - cached.computedAt < LARGEST_REFRESH_MS
        : !cached.wasScanning);
    const result = isFresh ? cached : computeLargest(limit);
    if (!isFresh) {
      largestCache = {...result, limit, version: structureVersion, computedAt: now, wasScanning: isScanning};
    }

    const toEntries = (candidates: Candidate[]): [string, FileInfo][] =>
      candidates
        .filter(candidate => store.isLive(candidate.id, candidate.generation))
        .map(candidate => {
          const path = candidatePath(candidate);
          return [path, views.viewFor(candidate.id, path, true)];
        });
    return {directories: toEntries(result.directories), files: toEntries(result.files)};
  }

  function candidatePath(candidate: Candidate): string {
    return (candidate.path ??= pathKeyFor(candidate.id));
  }

  /**
   * Select directories by the space they account for beyond their largest child directory.
   * This prevents a single large subtree from occupying the list once for every ancestor,
   * while still allowing branching ancestors to rank for the other space they contain.
   */
  function computeLargest(limit: number): {directories: Candidate[]; files: Candidate[]} {
    const directories: Candidate[] = [];
    const files: Candidate[] = [];
    let currentId = NONE;
    let currentPath: string | null = null;
    const pathOfCurrent = (id: number): string => {
      if (currentId !== id) {
        currentId = id;
        currentPath = null;
      }
      return (currentPath ??= pathKeyFor(id));
    };
    // Whether the entry ranks before `candidate`: larger selection size, then larger total
    // size, then path order.
    const ranksBefore = (
      id: number,
      size: number,
      selectionSize: number,
      candidate: Candidate,
    ): boolean => {
      if (selectionSize !== candidate.selectionSize) {
        return selectionSize > candidate.selectionSize;
      }
      if (size !== candidate.size) {
        return size > candidate.size;
      }
      return pathOfCurrent(id).localeCompare(candidatePath(candidate)) < 0;
    };
    const insert = (list: Candidate[], id: number, size: number, selectionSize: number): void => {
      if (list.length === limit && !ranksBefore(id, size, selectionSize, list[limit - 1])) {
        return;
      }
      let index = 0;
      while (index < list.length && !ranksBefore(id, size, selectionSize, list[index])) {
        index += 1;
      }
      list.splice(index, 0, {
        id,
        generation: store.generation(id),
        size,
        selectionSize,
        path: currentId === id ? currentPath : null,
      });
      if (list.length > limit) {
        list.pop();
      }
    };

    store.forEachInSubtree(visibleRoot, id => {
      if (id === visibleRoot) {
        return;
      }
      const flags = store.flags(id);
      const size = store.size(id);
      if (!(flags & DIRECTORY)) {
        insert(files, id, size, size);
        return;
      }
      if (flags & ALIAS) {
        return;
      }
      let largestChildSize = 0;
      for (let child = store.firstChild(id); child !== NONE; child = store.nextSibling(child)) {
        const childSize = store.size(child);
        if (isDirectoryEntry(child) && childSize > largestChildSize) {
          largestChildSize = childSize;
        }
      }
      const selectionSize = Math.max(0, size - largestChildSize);
      if (selectionSize > 0) {
        insert(directories, id, size, selectionSize);
      }
    });

    // Selection uses the non-redundant size, but the report remains ordered by total size.
    directories.sort(
      (a, b) => b.size - a.size || candidatePath(a).localeCompare(candidatePath(b)),
    );
    return {directories, files};
  }

  // Tree bookkeeping

  function setNodeType(id: number, isDirectory: boolean): void {
    if (isDirectoryEntry(id) === isDirectory) {
      return;
    }

    if (isDirectory) {
      filesScanned -= 1;
      directoriesScanned += 1;
      store.addFlags(id, DIRECTORY);
    } else {
      directoriesScanned -= 1;
      filesScanned += 1;
      store.clearFlags(id, DIRECTORY);
    }
  }

  function addSizeToAncestors(id: number, delta: number): void {
    for (let current = id; current !== NONE; current = store.parent(current)) {
      store.addSize(current, delta);
      store.clearFlags(current, COMPLETE);
    }
  }

  function countPendingDirectories(root: number): number {
    let count = 0;
    store.forEachInSubtree(root, id => {
      if ((store.flags(id) & (DIRECTORY | ENTRIES_READ)) === DIRECTORY) {
        count += 1;
      }
    });
    return count;
  }

  function restoreJobAncestors(job: ScanJob): void {
    for (const [ancestor, packed] of job.ancestorCompletion) {
      if (!store.isLive(ancestor, packed >> 1)) {
        continue;
      }
      if (packed & 1) {
        store.addFlags(ancestor, COMPLETE);
      } else {
        store.clearFlags(ancestor, COMPLETE);
      }
    }
  }

  function markAncestorsIncomplete(id: number): void {
    for (let current = id; current !== NONE; current = store.parent(current)) {
      store.clearFlags(current, COMPLETE);
    }
  }

  function recordError(job: ScanJob, id: number, error: Error): void {
    setNodeError(id, recordErrorAtPath(job, pathKeyFor(id), error));
  }

  function recordErrorAtPath(job: ScanJob, path: string, error: Error): DiskUsageError {
    const report = makeErrorReport(path, error);
    job.errors.push(report);
    return report;
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

  function isNodeActive(job: ScanJob, id: number, generation: number): boolean {
    return !job.controller.signal.aborted && activeJob === job && isLiveRef(id, generation);
  }

  function throwIfNodeInactive(job: ScanJob, id: number, generation: number): void {
    if (!isNodeActive(job, id, generation)) {
      throw new TraversalAbortedError();
    }
  }

  function throwIfStatTaskInactive(job: ScanJob, task: Extract<ScanTask, {type: 'stat'}>): void {
    if (task.node !== NONE) {
      throwIfNodeInactive(job, task.node, task.nodeGeneration);
    } else {
      throwIfNodeInactive(job, task.parent, task.parentGeneration);
    }
  }

  function getMemoryUsage(): DiskUsageMemoryUsage {
    return {
      entries: store.liveEntries,
      entryCapacity: store.entryCapacity,
      entryBytes: store.entryBytes,
      nameBytes: store.nameBytes,
      nameCapacityBytes: store.nameCapacityBytes,
      identityBytes: identities.byteLength,
    };
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
    getMemoryUsage,
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
 * The largest directories and files. Directories are selected by the space they account for
 * beyond their largest child directory, so one large subtree does not fill the list once for
 * every ancestor. While a scan runs, rankings are refreshed at most once per second.
 */
export function largestCandidates(progress: ProgressReport, count: number): LargestCandidates {
  return progress.largest(count);
}

export function largestDirectoryCandidates(
  progress: ProgressReport,
  count: number,
): [string, FileInfo][] {
  return progress.largest(count).directories;
}

export function largestFileCandidates(
  progress: ProgressReport,
  count: number,
): [string, FileInfo][] {
  return progress.largest(count).files;
}

function toFileError(report: DiskUsageError): Error {
  const error = new Error(report.message);
  return report.code ? Object.assign(error, {code: report.code}) : error;
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
