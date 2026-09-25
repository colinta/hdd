import {Buffer} from 'node:buffer';
import {dirname, resolve, sep} from 'node:path';
import type {
  FileSystem,
  FileSystemDirectory,
  FileSystemDirectoryEntry,
  FileSystemStats,
} from '../../filesystem.js';
import {ManualClock} from './manual-clock.js';

/*
 * A mock filesystem built from an indented text description:
 *
 *   /folder
 *     filename-1 1.2mb
 *     filename-2 2.4gb
 *   /folder2
 *     /folder3
 *       file-1  77.2mb
 *
 * - Indentation (spaces only) determines nesting; the common leading indentation is ignored,
 *   as are blank lines.
 * - `/name` (or `name/`) declares a directory. Directories can have an optional metadata size
 *   (`/folder 4kb`) but contribute zero bytes by default.
 * - Any other line is a file: a name (spaces allowed) followed by a size.
 * - Sizes are a number with an optional, case-insensitive unit: b, k/kb/kib, m/mb/mib, g/gb/gib,
 *   t/tb/tib, p/pb/pib. Units are 1024-based (matching `formatBytes`) and rounded to whole bytes.
 *
 * Timing (in simulated milliseconds on a ManualClock):
 * - `fileMs`: `lstat` of anything that is not a directory (files, symlinks, missing paths).
 * - `directoryMs`: `opendir`, charged once per directory scan.
 * - `directoryStatMs` (default 0): `lstat` of a directory.
 * - `readMs` (default 0): each directory handle `read()`.
 * Operations complete at the end of their delay: results reflect the filesystem at that moment.
 * `opendir` snapshots the entry names when it completes, like a real directory stream would.
 */

export type MockOperation = 'lstat' | 'opendir' | 'read' | 'close';

export interface MockFileSystemOptions {
  clock?: ManualClock;
  fileMs?: number;
  directoryMs?: number;
  directoryStatMs?: number;
  readMs?: number;
}

export interface MockEntryOptions {
  /** Allocated 512-byte blocks. When set, the scanner counts `blocks * 512` instead of size. */
  blocks?: number;
}

export interface MockOperationRecord {
  operation: MockOperation;
  path: string;
  startedAt: number;
  completedAt: number | null;
  /** The error code when the operation failed. */
  error: string | null;
}

interface MockFile {
  type: 'file';
  size: number;
  blocks?: number;
}

interface MockDirectory {
  type: 'directory';
  size: number;
  blocks?: number;
  children: Map<string, MockNode>;
}

interface MockSymlink {
  type: 'symlink';
  target: string;
  size: number;
  blocks?: number;
}

type MockNode = MockFile | MockDirectory | MockSymlink;

const UNIT_POWERS: Record<string, number> = {
  b: 0,
  k: 1,
  kb: 1,
  kib: 1,
  m: 2,
  mb: 2,
  mib: 2,
  g: 3,
  gb: 3,
  gib: 3,
  t: 4,
  tb: 4,
  tib: 4,
  p: 5,
  pb: 5,
  pib: 5,
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)([a-z]*)$/i;

/** Parses `1.2mb`-style sizes (1024-based) into whole bytes. Numbers are returned as-is. */
export function parseSize(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid size: ${input}`);
    }
    return Math.round(input);
  }

  const bytes = tryParseSize(input);
  if (bytes === null) {
    throw new Error(`Invalid size: "${input}"`);
  }
  return bytes;
}

function tryParseSize(text: string): number | null {
  const match = SIZE_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  const power = UNIT_POWERS[(match[2] || 'b').toLowerCase()];
  if (power === undefined) {
    return null;
  }
  return Math.round(Number(match[1]) * 1024 ** power);
}

export class FileSystemDescriptionError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`Line ${line}: ${message}`);
    this.name = 'FileSystemDescriptionError';
  }
}

function createDirectory(size = 0, blocks?: number): MockDirectory {
  return {type: 'directory', size, ...(blocks === undefined ? {} : {blocks}), children: new Map()};
}

/** Parses a text description into the children of a new directory. */
function parseDescription(description: string): MockDirectory {
  const root = createDirectory();
  const lines = description.split(/\r?\n/).map((text, index) => ({text, number: index + 1}));
  const contentLines = lines.filter(line => line.text.trim() !== '');

  for (const line of contentLines) {
    const leading = /^[ \t]*/.exec(line.text)![0];
    if (leading.includes('\t')) {
      throw new FileSystemDescriptionError('indent with spaces, not tabs', line.number);
    }
  }

  const commonIndent = Math.min(
    ...contentLines.map(line => /^ */.exec(line.text)![0].length),
  );

  interface Frame {
    indent: number;
    directory: MockDirectory;
    childIndent: number | null;
  }
  const stack: Frame[] = [{indent: -1, directory: root, childIndent: null}];
  let previous: {indent: number; isDirectory: boolean} | null = null;

  for (const line of contentLines) {
    const indent = /^ */.exec(line.text)![0].length - commonIndent;
    const content = line.text.trim();
    const entry = parseLine(content, line.number);

    if (previous && indent > previous.indent && !previous.isDirectory) {
      throw new FileSystemDescriptionError(
        `"${entry.name}" is indented beneath a file; only directories can contain entries`,
        line.number,
      );
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1];
    if (frame.childIndent === null) {
      frame.childIndent = indent;
    } else if (frame.childIndent !== indent) {
      throw new FileSystemDescriptionError(
        `inconsistent indentation for "${entry.name}" (expected ${frame.childIndent} spaces, found ${indent})`,
        line.number,
      );
    }
    if (frame.directory.children.has(entry.name)) {
      throw new FileSystemDescriptionError(`duplicate entry "${entry.name}"`, line.number);
    }

    if (entry.isDirectory) {
      const directory = createDirectory(entry.size ?? 0);
      frame.directory.children.set(entry.name, directory);
      stack.push({indent, directory, childIndent: null});
    } else {
      frame.directory.children.set(entry.name, {type: 'file', size: entry.size!});
    }
    previous = {indent, isDirectory: entry.isDirectory};
  }

  return root;
}

function parseLine(
  content: string,
  lineNumber: number,
): {name: string; isDirectory: boolean; size: number | null} {
  const sizeMatch = /^(.*\S)\s+(\S+)$/.exec(content);
  const size = sizeMatch ? tryParseSize(sizeMatch[2]) : null;
  let name = size !== null ? sizeMatch![1] : content;

  const isDirectory = name.startsWith('/') || name.endsWith('/');
  if (isDirectory) {
    name = name.replace(/^\//, '').replace(/\/$/, '');
  }

  if (!name || name.includes('/') || name === '.' || name === '..') {
    throw new FileSystemDescriptionError(`invalid name "${content}"`, lineNumber);
  }
  if (!isDirectory && size === null) {
    throw new FileSystemDescriptionError(
      `file "${name}" needs a size (e.g. "${name} 1.2mb"); prefix directories with "/"`,
      lineNumber,
    );
  }

  return {name, isDirectory, size};
}

const ERROR_DESCRIPTIONS: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  EIO: 'i/o error',
  ELOOP: 'too many symbolic links encountered',
  EMFILE: 'too many open files',
};

export function createFileSystemError(code: string, syscall: string, path: string): Error {
  const description = ERROR_DESCRIPTIONS[code] ?? 'unknown error';
  return Object.assign(new Error(`${code}: ${description}, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

/** Holds a single matching filesystem operation in flight until released. */
export class MockGate {
  reached = false;
  released = false;
  private resolveReached!: () => void;
  private readonly reachedPromise = new Promise<void>(resolve => {
    this.resolveReached = resolve;
  });
  private resolveRelease!: () => void;
  private rejectRelease!: (error: Error) => void;
  private readonly releasePromise = new Promise<void>((resolve, reject) => {
    this.resolveRelease = resolve;
    this.rejectRelease = reject;
  });

  constructor(
    readonly operation: MockOperation,
    readonly path: string,
  ) {}

  /** Resolves once a matching operation is being held (after its simulated delay). */
  whenReached(): Promise<void> {
    return this.reachedPromise;
  }

  /** Lets the held operation complete, observing the filesystem as it is now. */
  release(): void {
    this.released = true;
    this.resolveRelease();
  }

  /** Makes the held operation reject with a filesystem error code or error. */
  fail(error: string | Error): void {
    this.released = true;
    this.rejectRelease(
      typeof error === 'string' ? createFileSystemError(error, this.operation, this.path) : error,
    );
  }

  /** @internal */
  hold(): Promise<void> {
    this.reached = true;
    this.resolveReached();
    return this.releasePromise;
  }
}

class MockDirectoryHandle implements FileSystemDirectory {
  private index = 0;
  isClosed = false;

  constructor(
    private readonly fileSystem: MockFileSystem,
    readonly path: string,
    private readonly names: string[],
  ) {}

  read(): Promise<FileSystemDirectoryEntry | null> {
    return this.fileSystem.perform('read', this.path, this.fileSystem.delayFor('read', this.path), () => {
      if (this.isClosed) {
        throw Object.assign(new Error('Directory handle was closed'), {code: 'ERR_DIR_CLOSED'});
      }
      return this.index < this.names.length ? {name: this.names[this.index++]} : null;
    });
  }

  close(): Promise<void> {
    return this.fileSystem.perform('close', this.path, 0, () => {
      if (this.isClosed) {
        throw Object.assign(new Error('Directory handle was closed'), {code: 'ERR_DIR_CLOSED'});
      }
      this.isClosed = true;
      this.fileSystem.handleClosed(this);
    });
  }
}

export class MockFileSystem implements FileSystem {
  readonly clock: ManualClock;
  fileMs: number;
  directoryMs: number;
  directoryStatMs: number;
  readMs: number;
  /** Every operation in the order it started. */
  readonly operations: MockOperationRecord[] = [];
  /** Number of operations currently in flight, and the most seen at once. */
  inFlight = 0;
  maxInFlight = 0;
  /** Most directory handles open at once. */
  maxOpenHandles = 0;

  private root: MockDirectory;
  private readonly handles = new Set<MockDirectoryHandle>();
  private readonly delays = new Map<string, number>();
  private readonly failures = new Map<string, string | Error>();
  private readonly gates: MockGate[] = [];

  constructor(description = '', options: MockFileSystemOptions = {}) {
    this.root = parseDescription(description);
    this.clock = options.clock ?? new ManualClock();
    this.fileMs = options.fileMs ?? 0;
    this.directoryMs = options.directoryMs ?? 0;
    this.directoryStatMs = options.directoryStatMs ?? 0;
    this.readMs = options.readMs ?? 0;
  }

  // FileSystem implementation

  lstat(path: string): Promise<FileSystemStats> {
    const absolutePath = normalize(path);
    const initial = this.lookup(absolutePath, false);
    const delay =
      this.delays.get(delayKey('lstat', absolutePath)) ??
      (initial.node?.type === 'directory' ? this.directoryStatMs : this.fileMs);

    return this.perform('lstat', absolutePath, delay, () => {
      const {node, error} = this.lookup(absolutePath, false);
      if (!node) {
        throw createFileSystemError(error, 'lstat', absolutePath);
      }
      return {
        size: node.size,
        ...(node.blocks === undefined ? {} : {blocks: node.blocks}),
        isDirectory: () => node.type === 'directory',
        isFile: () => node.type === 'file',
        isSymbolicLink: () => node.type === 'symlink',
      };
    });
  }

  opendir(path: string): Promise<FileSystemDirectory> {
    const absolutePath = normalize(path);
    return this.perform('opendir', path, this.delayFor('opendir', absolutePath), () => {
      const {node, error} = this.lookup(absolutePath, true);
      if (!node) {
        throw createFileSystemError(error, 'opendir', absolutePath);
      }
      if (node.type !== 'directory') {
        throw createFileSystemError('ENOTDIR', 'opendir', absolutePath);
      }
      const handle = new MockDirectoryHandle(this, path, [...node.children.keys()]);
      this.handles.add(handle);
      this.maxOpenHandles = Math.max(this.maxOpenHandles, this.handles.size);
      return handle;
    });
  }

  // Inspection

  get openHandles(): number {
    return this.handles.size;
  }

  exists(path: string): boolean {
    return this.lookup(normalize(path), false).node !== null;
  }

  /** Operations matching the filter, e.g. `operationsFor({operation: 'lstat'})`. */
  operationsFor(filter: {operation?: MockOperation; path?: string; within?: string}): MockOperationRecord[] {
    const path = filter.path === undefined ? undefined : normalize(filter.path);
    const within = filter.within === undefined ? undefined : normalize(filter.within);
    return this.operations.filter(
      record =>
        (!filter.operation || record.operation === filter.operation) &&
        (path === undefined || record.path === path) &&
        (within === undefined || isSameOrDescendant(record.path, within)),
    );
  }

  clearOperations(): void {
    this.operations.length = 0;
  }

  /**
   * The size the scanner should report for a path: allocated blocks (× 512) when set, otherwise
   * the apparent size, summed over the subtree. Symbolic links are not followed.
   */
  diskUsage(path = '/'): number {
    const {node} = this.lookup(normalize(path), false);
    if (!node) {
      throw createFileSystemError('ENOENT', 'diskUsage', path);
    }
    return usage(node);
  }

  // Mutation. These are setup helpers: they create missing parents and replace existing entries.

  /** Replaces the entire filesystem with a new description. */
  replace(description: string): void {
    this.root = parseDescription(description);
  }

  /** Adds described entries inside a directory (created if missing). */
  add(directoryPath: string, description: string): void {
    const directory = this.ensureDirectory(normalize(directoryPath));
    for (const [name, node] of parseDescription(description).children) {
      if (directory.children.has(name)) {
        throw new Error(`Cannot add "${name}": it already exists in ${directoryPath}`);
      }
      directory.children.set(name, node);
    }
  }

  writeFile(path: string, size: number | string, options: MockEntryOptions = {}): void {
    this.setNode(path, {type: 'file', size: parseSize(size), ...options});
  }

  /** Creates a directory (and parents). An existing directory keeps its children. */
  mkdir(path: string, options: MockEntryOptions & {size?: number | string} = {}): void {
    const directory = this.ensureDirectory(normalize(path));
    if (options.size !== undefined) {
      directory.size = parseSize(options.size);
    }
    if (options.blocks !== undefined) {
      directory.blocks = options.blocks;
    }
  }

  symlink(path: string, target: string, options: MockEntryOptions & {size?: number | string} = {}): void {
    this.setNode(path, {
      type: 'symlink',
      target,
      size: options.size === undefined ? Buffer.byteLength(target) : parseSize(options.size),
      ...(options.blocks === undefined ? {} : {blocks: options.blocks}),
    });
  }

  /** Removes an entry and everything beneath it. */
  remove(path: string): void {
    const absolutePath = normalize(path);
    const parent = this.lookup(dirname(absolutePath), true).node;
    const name = baseName(absolutePath);
    if (parent?.type !== 'directory' || !parent.children.delete(name)) {
      throw new Error(`Cannot remove "${path}": it does not exist`);
    }
  }

  // Failures, timing, and gates

  /** Makes every matching operation fail with the error (or error code) until cleared. */
  fail(path: string, operation: MockOperation, error: string | Error): void {
    this.failures.set(delayKey(operation, normalize(path)), error);
  }

  clearFailure(path: string, operation?: MockOperation): void {
    const absolutePath = normalize(path);
    for (const op of operation ? [operation] : (['lstat', 'opendir', 'read', 'close'] as const)) {
      this.failures.delete(delayKey(op, absolutePath));
    }
  }

  /** Overrides the simulated duration of an operation on one path. */
  setDelay(path: string, operation: MockOperation, ms: number): void {
    this.delays.set(delayKey(operation, normalize(path)), ms);
  }

  /** Holds the next matching operation after its simulated delay, until the gate is released. */
  hold(path: string, operation: MockOperation): MockGate {
    const gate = new MockGate(operation, normalize(path));
    this.gates.push(gate);
    return gate;
  }

  /** @internal */
  delayFor(operation: MockOperation, path: string): number {
    const override = this.delays.get(delayKey(operation, normalize(path)));
    if (override !== undefined) {
      return override;
    }
    switch (operation) {
      case 'opendir':
        return this.directoryMs;
      case 'read':
        return this.readMs;
      default:
        return 0;
    }
  }

  /** @internal */
  handleClosed(handle: MockDirectoryHandle): void {
    this.handles.delete(handle);
  }

  /** @internal Runs an operation with its delay, gate, and injected failure. */
  async perform<T>(operation: MockOperation, path: string, delayMs: number, run: () => T): Promise<T> {
    const absolutePath = normalize(path);
    const record: MockOperationRecord = {
      operation,
      path: absolutePath,
      startedAt: this.clock.now(),
      completedAt: null,
      error: null,
    };
    this.operations.push(record);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    try {
      if (delayMs > 0) {
        await this.clock.sleep(delayMs);
      } else {
        await Promise.resolve();
      }

      const gateIndex = this.gates.findIndex(
        gate => gate.operation === operation && gate.path === absolutePath,
      );
      if (gateIndex >= 0) {
        const [gate] = this.gates.splice(gateIndex, 1);
        await gate.hold();
      }

      const failure = this.failures.get(delayKey(operation, absolutePath));
      if (failure !== undefined) {
        throw typeof failure === 'string'
          ? createFileSystemError(failure, operation, absolutePath)
          : failure;
      }

      return run();
    } catch (caught) {
      record.error = (caught as {code?: string}).code ?? 'ERROR';
      throw caught;
    } finally {
      this.inFlight -= 1;
      record.completedAt = this.clock.now();
    }
  }

  private lookup(
    absolutePath: string,
    followFinalSymlink: boolean,
    depth = 0,
  ): {node: MockNode; error?: undefined} | {node: null; error: string} {
    if (depth > 40) {
      return {node: null, error: 'ELOOP'};
    }

    const segments = absolutePath.split(sep).filter(Boolean);
    let node: MockNode = this.root;
    let currentPath: string = sep;
    for (let index = 0; index < segments.length; index++) {
      if (node.type === 'symlink') {
        const resolved = this.lookup(resolve(dirname(currentPath), node.target), true, depth + 1);
        if (!resolved.node) {
          return resolved;
        }
        node = resolved.node;
      }
      if (node.type !== 'directory') {
        return {node: null, error: 'ENOTDIR'};
      }
      const child = node.children.get(segments[index]);
      if (!child) {
        return {node: null, error: 'ENOENT'};
      }
      node = child;
      currentPath = resolve(currentPath, segments[index]);
    }

    if (followFinalSymlink && node.type === 'symlink') {
      return this.lookup(resolve(dirname(currentPath), node.target), true, depth + 1);
    }
    return {node};
  }

  private ensureDirectory(absolutePath: string): MockDirectory {
    let directory = this.root;
    for (const segment of absolutePath.split(sep).filter(Boolean)) {
      const child = directory.children.get(segment);
      if (child?.type === 'directory') {
        directory = child;
      } else {
        const created = createDirectory();
        directory.children.set(segment, created);
        directory = created;
      }
    }
    return directory;
  }

  private setNode(path: string, node: MockNode): void {
    const absolutePath = normalize(path);
    if (absolutePath === sep) {
      throw new Error('Cannot replace the filesystem root');
    }
    this.ensureDirectory(dirname(absolutePath)).children.set(baseName(absolutePath), node);
  }
}

export function createMockFileSystem(
  description = '',
  options: MockFileSystemOptions = {},
): MockFileSystem {
  return new MockFileSystem(description, options);
}

function usage(node: MockNode): number {
  let total = node.blocks === undefined ? node.size : node.blocks * 512;
  if (node.type === 'directory') {
    for (const child of node.children.values()) {
      total += usage(child);
    }
  }
  return total;
}

function normalize(path: string): string {
  return resolve(sep, path);
}

function baseName(absolutePath: string): string {
  return absolutePath.slice(absolutePath.lastIndexOf(sep) + 1);
}

function delayKey(operation: MockOperation, absolutePath: string): string {
  return `${operation}\0${absolutePath}`;
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  return (
    ancestor === sep || path === ancestor || path.startsWith(ancestor + sep)
  );
}
