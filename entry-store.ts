import {Buffer} from 'node:buffer';

/*
 * Compact storage for scanned filesystem entries.
 *
 * Entries are addressed by numeric IDs rather than JavaScript objects. Each entry keeps only
 * its parent, its first child and next sibling (an intrusive child list), a reference to its
 * UTF-8 basename, its size, and a few flag bits: about 28 bytes plus the name bytes. Full paths
 * are never stored; they are reconstructed from the parent chain when needed.
 *
 * Released IDs are recycled. Every release increments the slot's generation, so a stale
 * `(id, generation)` pair held by in-flight work or an old view can be detected safely.
 */

export const NONE = 0;

export const IN_USE = 1 << 0;
export const DIRECTORY = 1 << 1;
export const COMPLETE = 1 << 2;
export const ENTRIES_READ = 1 << 3;
export const HAS_ERROR = 1 << 4;
/** A directory already counted under another path (same device and inode). */
export const ALIAS = 1 << 5;
/** Root of a subtree kept aside (for rollback) rather than linked into the visible tree. */
export const DETACHED = 1 << 6;

const ENTRY_CHUNK_BITS = 16;
const ENTRY_CHUNK_SIZE = 1 << ENTRY_CHUNK_BITS;
const ENTRY_CHUNK_MASK = ENTRY_CHUNK_SIZE - 1;
// IDs are stored in Uint32 fields; 0 is NONE and 0xffffffff is reserved by the identity table.
const MAX_ENTRY_ID = 0xfffffffe;

const NAME_CHUNK_BITS = 20;
const NAME_CHUNK_SIZE = 1 << NAME_CHUNK_BITS;
const NAME_CHUNK_MASK = NAME_CHUNK_SIZE - 1;
const MAX_NAME_CHUNKS = 2 ** (32 - NAME_CHUNK_BITS);
const INITIAL_NAME_CHUNK_SIZE = 4096;
export const MAX_NAME_BYTES = 0xffff;
const DEFAULT_NAME_COMPACTION_MIN_BYTES = 4 * NAME_CHUNK_SIZE;

type NumericChunk = Uint8Array | Uint16Array | Uint32Array | Float64Array;

/** A typed array split into fixed-size chunks, so growing never copies existing data. */
class ChunkedArray<T extends NumericChunk> {
  readonly chunks: T[] = [];

  constructor(private readonly createChunk: (length: number) => T) {}

  get(index: number): number {
    return this.chunks[index >>> ENTRY_CHUNK_BITS][index & ENTRY_CHUNK_MASK];
  }

  set(index: number, value: number): void {
    this.chunks[index >>> ENTRY_CHUNK_BITS][index & ENTRY_CHUNK_MASK] = value;
  }

  addChunk(): void {
    this.chunks.push(this.createChunk(ENTRY_CHUNK_SIZE));
  }

  get byteLength(): number {
    let total = 0;
    for (const chunk of this.chunks) {
      total += chunk.byteLength;
    }
    return total;
  }
}

/**
 * Append-only UTF-8 name storage. A reference encodes `chunk * NAME_CHUNK_SIZE + offset`; names
 * never straddle chunks. Only the most recent chunk grows, so small scans stay small.
 */
class NameArena {
  private readonly chunks: Buffer[] = [];
  private used = 0;
  liveBytes = 0;
  deadBytes = 0;

  write(name: string, length: number): number {
    const chunk = this.reserve(length);
    const offset = this.used;
    if (length) {
      chunk.write(name, offset, length, 'utf8');
    }
    this.used += length;
    this.liveBytes += length;
    return (this.chunks.length - 1) * NAME_CHUNK_SIZE + offset;
  }

  copyFrom(source: NameArena, ref: number, length: number): number {
    const chunk = this.reserve(length);
    const offset = this.used;
    if (length) {
      const start = ref & NAME_CHUNK_MASK;
      source.chunks[ref >>> NAME_CHUNK_BITS].copy(chunk, offset, start, start + length);
    }
    this.used += length;
    this.liveBytes += length;
    return (this.chunks.length - 1) * NAME_CHUNK_SIZE + offset;
  }

  read(ref: number, length: number): string {
    if (!length) {
      return '';
    }
    const start = ref & NAME_CHUNK_MASK;
    return this.chunks[ref >>> NAME_CHUNK_BITS].toString('utf8', start, start + length);
  }

  equals(ref: number, length: number, bytes: Uint8Array): boolean {
    if (length !== bytes.length) {
      return false;
    }
    const chunk = this.chunks[ref >>> NAME_CHUNK_BITS];
    const start = ref & NAME_CHUNK_MASK;
    for (let index = 0; index < length; index++) {
      if (chunk[start + index] !== bytes[index]) {
        return false;
      }
    }
    return true;
  }

  release(length: number): void {
    this.liveBytes -= length;
    this.deadBytes += length;
  }

  get byteLength(): number {
    let total = 0;
    for (const chunk of this.chunks) {
      total += chunk.length;
    }
    return total;
  }

  private reserve(length: number): Buffer {
    const last = this.chunks.length - 1;
    let chunk = this.chunks[last];
    if (!chunk || this.used + length > NAME_CHUNK_SIZE) {
      if (this.chunks.length >= MAX_NAME_CHUNKS) {
        throw new Error('Name storage is full');
      }
      const size = this.chunks.length ? NAME_CHUNK_SIZE : INITIAL_NAME_CHUNK_SIZE;
      chunk = Buffer.allocUnsafeSlow(Math.max(size, length));
      this.chunks.push(chunk);
      this.used = 0;
    } else if (this.used + length > chunk.length) {
      const grown = Buffer.allocUnsafeSlow(
        Math.min(NAME_CHUNK_SIZE, Math.max(chunk.length * 2, this.used + length)),
      );
      chunk.copy(grown, 0, 0, this.used);
      this.chunks[last] = grown;
      chunk = grown;
    }
    return chunk;
  }
}

export interface EntryStoreOptions {
  /** Released name bytes that must accumulate (and exceed live bytes) before compaction. */
  nameCompactionMinBytes?: number;
}

export class EntryStore {
  private readonly parents = new ChunkedArray(length => new Uint32Array(length));
  private readonly firstChildren = new ChunkedArray(length => new Uint32Array(length));
  private readonly nextSiblings = new ChunkedArray(length => new Uint32Array(length));
  private readonly nameRefs = new ChunkedArray(length => new Uint32Array(length));
  private readonly nameLengths = new ChunkedArray(length => new Uint16Array(length));
  private readonly sizes = new ChunkedArray(length => new Float64Array(length));
  private readonly flagBits = new ChunkedArray(length => new Uint8Array(length));
  private readonly generations = new ChunkedArray(length => new Uint8Array(length));
  private names = new NameArena();
  private capacity = 0;
  private nextUnused = 1;
  // Released slots form a list threaded through `nextSiblings`.
  private freeHead = NONE;
  private live = 0;
  private readonly nameCompactionMinBytes: number;

  constructor(options: EntryStoreOptions = {}) {
    this.nameCompactionMinBytes =
      options.nameCompactionMinBytes ?? DEFAULT_NAME_COMPACTION_MIN_BYTES;
  }

  get liveEntries(): number {
    return this.live;
  }

  get entryCapacity(): number {
    return this.capacity;
  }

  get entryBytes(): number {
    return (
      this.parents.byteLength +
      this.firstChildren.byteLength +
      this.nextSiblings.byteLength +
      this.nameRefs.byteLength +
      this.nameLengths.byteLength +
      this.sizes.byteLength +
      this.flagBits.byteLength +
      this.generations.byteLength
    );
  }

  get nameBytes(): number {
    return this.names.liveBytes;
  }

  get nameCapacityBytes(): number {
    return this.names.byteLength;
  }

  /** Allocates an unlinked entry. Link it with `prependChild` or `replaceChild`. */
  allocate(name: string, parent: number, flags: number, size: number): number {
    const nameLength = Buffer.byteLength(name, 'utf8');
    if (nameLength > MAX_NAME_BYTES) {
      throw new Error(`Name is too long to store (${nameLength} bytes)`);
    }

    let id = this.freeHead;
    if (id === NONE && this.nextUnused > MAX_ENTRY_ID) {
      throw new Error('Too many entries to store');
    }
    const nameRef = this.names.write(name, nameLength);
    if (id !== NONE) {
      this.freeHead = this.nextSiblings.get(id);
    } else {
      id = this.nextUnused++;
      while (id >= this.capacity) {
        this.grow();
      }
    }

    this.parents.set(id, parent);
    this.firstChildren.set(id, NONE);
    this.nextSiblings.set(id, NONE);
    this.nameRefs.set(id, nameRef);
    this.nameLengths.set(id, nameLength);
    this.sizes.set(id, size);
    this.flagBits.set(id, flags | IN_USE);
    this.live += 1;
    return id;
  }

  isLive(id: number, generation: number): boolean {
    return (
      id !== NONE &&
      id < this.nextUnused &&
      (this.flagBits.get(id) & IN_USE) !== 0 &&
      this.generations.get(id) === generation
    );
  }

  generation(id: number): number {
    return this.generations.get(id);
  }

  parent(id: number): number {
    return this.parents.get(id);
  }

  firstChild(id: number): number {
    return this.firstChildren.get(id);
  }

  nextSibling(id: number): number {
    return this.nextSiblings.get(id);
  }

  name(id: number): string {
    return this.names.read(this.nameRefs.get(id), this.nameLengths.get(id));
  }

  nameEquals(id: number, bytes: Uint8Array): boolean {
    return this.names.equals(this.nameRefs.get(id), this.nameLengths.get(id), bytes);
  }

  size(id: number): number {
    return this.sizes.get(id);
  }

  setSize(id: number, size: number): void {
    this.sizes.set(id, size);
  }

  addSize(id: number, delta: number): void {
    this.sizes.set(id, this.sizes.get(id) + delta);
  }

  flags(id: number): number {
    return this.flagBits.get(id);
  }

  addFlags(id: number, mask: number): void {
    this.flagBits.set(id, this.flagBits.get(id) | mask);
  }

  clearFlags(id: number, mask: number): void {
    this.flagBits.set(id, this.flagBits.get(id) & ~(mask & ~IN_USE));
  }

  prependChild(parent: number, child: number): void {
    this.parents.set(child, parent);
    this.nextSiblings.set(child, this.firstChildren.get(parent));
    this.firstChildren.set(parent, child);
  }

  /** Removes `child` from its parent's child list. Returns false when it is not listed there. */
  unlinkChild(parent: number, child: number): boolean {
    let previous = NONE;
    for (
      let current = this.firstChildren.get(parent);
      current !== NONE;
      current = this.nextSiblings.get(current)
    ) {
      if (current === child) {
        const next = this.nextSiblings.get(current);
        if (previous === NONE) {
          this.firstChildren.set(parent, next);
        } else {
          this.nextSiblings.set(previous, next);
        }
        this.nextSiblings.set(child, NONE);
        return true;
      }
      previous = current;
    }
    return false;
  }

  /** Puts `replacement` where `child` is in its parent's list. Returns false if not listed. */
  replaceChild(parent: number, child: number, replacement: number): boolean {
    let previous = NONE;
    for (
      let current = this.firstChildren.get(parent);
      current !== NONE;
      current = this.nextSiblings.get(current)
    ) {
      if (current === child) {
        this.nextSiblings.set(replacement, this.nextSiblings.get(current));
        if (previous === NONE) {
          this.firstChildren.set(parent, replacement);
        } else {
          this.nextSiblings.set(previous, replacement);
        }
        this.parents.set(replacement, parent);
        this.nextSiblings.set(child, NONE);
        return true;
      }
      previous = current;
    }
    return false;
  }

  findChild(parent: number, name: Uint8Array): number {
    for (
      let current = this.firstChildren.get(parent);
      current !== NONE;
      current = this.nextSiblings.get(current)
    ) {
      if (this.nameEquals(current, name)) {
        return current;
      }
    }
    return NONE;
  }

  /** Visits `root` and its descendants in pre-order. `visit` must not change the tree. */
  forEachInSubtree(root: number, visit: (id: number) => void): void {
    let id = root;
    while (true) {
      visit(id);
      const child = this.firstChildren.get(id);
      if (child !== NONE) {
        id = child;
        continue;
      }
      while (id !== root && this.nextSiblings.get(id) === NONE) {
        id = this.parents.get(id);
      }
      if (id === root) {
        return;
      }
      id = this.nextSiblings.get(id);
    }
  }

  /**
   * Releases `root` and its descendants, visiting each (children first) before its slot is
   * recycled. The caller must already have unlinked `root` from its parent.
   */
  releaseSubtree(root: number, visit?: (id: number) => void): void {
    let id = root;
    descend: while (true) {
      for (let child = this.firstChildren.get(id); child !== NONE; child = this.firstChildren.get(id)) {
        id = child;
      }
      while (true) {
        const next = id === root ? NONE : this.nextSiblings.get(id);
        const parent = this.parents.get(id);
        visit?.(id);
        this.release(id);
        if (id === root) {
          this.maybeCompactNames();
          return;
        }
        if (next !== NONE) {
          id = next;
          continue descend;
        }
        // Every child of `parent` has been released; release the parent next.
        id = parent;
      }
    }
  }

  private release(id: number): void {
    this.names.release(this.nameLengths.get(id));
    this.flagBits.set(id, 0);
    this.generations.set(id, (this.generations.get(id) + 1) & 0xff);
    this.parents.set(id, NONE);
    this.firstChildren.set(id, NONE);
    this.sizes.set(id, 0);
    this.nameLengths.set(id, 0);
    this.nextSiblings.set(id, this.freeHead);
    this.freeHead = id;
    this.live -= 1;
  }

  private grow(): void {
    this.parents.addChunk();
    this.firstChildren.addChunk();
    this.nextSiblings.addChunk();
    this.nameRefs.addChunk();
    this.nameLengths.addChunk();
    this.sizes.addChunk();
    this.flagBits.addChunk();
    this.generations.addChunk();
    this.capacity += ENTRY_CHUNK_SIZE;
  }

  private maybeCompactNames(): void {
    const {deadBytes, liveBytes} = this.names;
    if (deadBytes < this.nameCompactionMinBytes || deadBytes <= liveBytes) {
      return;
    }

    const compacted = new NameArena();
    for (let id = 1; id < this.nextUnused; id++) {
      if (this.flagBits.get(id) & IN_USE) {
        this.nameRefs.set(
          id,
          compacted.copyFrom(this.names, this.nameRefs.get(id), this.nameLengths.get(id)),
        );
      }
    }
    this.names = compacted;
  }
}

export const IDENTITY_STALE = 0;
export const IDENTITY_KEEP = 1;
export const IDENTITY_MATCH = 2;
export type IdentityClassification =
  | typeof IDENTITY_STALE
  | typeof IDENTITY_KEEP
  | typeof IDENTITY_MATCH;

const EMPTY_SLOT = 0;
const TOMBSTONE = 0xffffffff;
const MIN_IDENTITY_CAPACITY = 64;

/**
 * Splits a device or inode number into two 32-bit words. Returns false when the value is
 * missing or cannot be represented exactly (a JavaScript number above 2^53).
 */
function writeIdentityPart(value: unknown, out: Uint32Array, offset: number): boolean {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      return false;
    }
    out[offset] = Number((value >> 32n) & 0xffffffffn);
    out[offset + 1] = Number(value & 0xffffffffn);
    return true;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    out[offset] = Math.floor(value / 2 ** 32);
    out[offset + 1] = value >>> 0;
    return true;
  }
  return false;
}

/** Writes `(dev, ino)` into four words. Returns false when either is unavailable or inexact. */
export function readDirectoryIdentity(
  stats: {dev?: number | bigint; ino?: number | bigint},
  out: Uint32Array,
): boolean {
  // A device number of 0 is legitimate; only the inode must be non-zero.
  if (stats.dev === 0 || stats.dev === 0n) {
    out[0] = 0;
    out[1] = 0;
  } else if (!writeIdentityPart(stats.dev, out, 0)) {
    return false;
  }
  return writeIdentityPart(stats.ino, out, 2);
}

/**
 * An open-addressed table from directory identity `(dev, ino)` to the entry that owns it.
 * Several entries may share an identity (for example, a subtree kept aside for rollback and
 * its replacement); `classify` decides which are current. Stale entries are dropped lazily.
 */
export class DirectoryIdentityTable {
  private keys = new Uint32Array(0);
  private ids = new Uint32Array(0);
  private generations = new Uint8Array(0);
  private occupied = 0;

  constructor(
    private readonly classify: (id: number, generation: number) => IdentityClassification,
  ) {}

  get capacity(): number {
    return this.ids.length;
  }

  get byteLength(): number {
    return this.keys.byteLength + this.ids.byteLength + this.generations.byteLength;
  }

  /** Returns the current owner of an identity, or NONE. */
  find(identity: Uint32Array): number {
    const capacity = this.ids.length;
    if (!capacity) {
      return NONE;
    }
    const mask = capacity - 1;
    for (let slot = hashIdentity(identity) & mask; ; slot = (slot + 1) & mask) {
      const id = this.ids[slot];
      if (id === EMPTY_SLOT) {
        return NONE;
      }
      if (id === TOMBSTONE || !this.matches(slot, identity)) {
        continue;
      }
      const classification = this.classify(id, this.generations[slot]);
      if (classification === IDENTITY_MATCH) {
        return id;
      }
      if (classification === IDENTITY_STALE) {
        this.ids[slot] = TOMBSTONE;
      }
    }
  }

  insert(identity: Uint32Array, id: number, generation: number): void {
    if ((this.occupied + 1) * 2 > this.ids.length) {
      this.rebuild();
    }
    this.place(identity, 0, id, generation);
  }

  private place(key: Uint32Array, keyOffset: number, id: number, generation: number): void {
    const mask = this.ids.length - 1;
    let slot = hashIdentity(key, keyOffset) & mask;
    while (this.ids[slot] !== EMPTY_SLOT && this.ids[slot] !== TOMBSTONE) {
      slot = (slot + 1) & mask;
    }
    if (this.ids[slot] === EMPTY_SLOT) {
      this.occupied += 1;
    }
    const base = slot * 4;
    this.keys[base] = key[keyOffset];
    this.keys[base + 1] = key[keyOffset + 1];
    this.keys[base + 2] = key[keyOffset + 2];
    this.keys[base + 3] = key[keyOffset + 3];
    this.ids[slot] = id;
    this.generations[slot] = generation;
  }

  private matches(slot: number, identity: Uint32Array): boolean {
    const base = slot * 4;
    return (
      this.keys[base] === identity[0] &&
      this.keys[base + 1] === identity[1] &&
      this.keys[base + 2] === identity[2] &&
      this.keys[base + 3] === identity[3]
    );
  }

  private rebuild(): void {
    const {keys, ids, generations} = this;
    const retained: number[] = [];
    for (let slot = 0; slot < ids.length; slot++) {
      const id = ids[slot];
      if (
        id !== EMPTY_SLOT &&
        id !== TOMBSTONE &&
        this.classify(id, generations[slot]) !== IDENTITY_STALE
      ) {
        retained.push(slot);
      }
    }

    let capacity = MIN_IDENTITY_CAPACITY;
    while (capacity < (retained.length + 1) * 4) {
      capacity *= 2;
    }
    this.keys = new Uint32Array(capacity * 4);
    this.ids = new Uint32Array(capacity);
    this.generations = new Uint8Array(capacity);
    this.occupied = 0;
    for (const slot of retained) {
      this.place(keys, slot * 4, ids[slot], generations[slot]);
    }
  }
}

function hashIdentity(key: Uint32Array, offset = 0): number {
  let hash = 0x811c9dc5;
  for (let index = offset; index < offset + 4; index++) {
    hash = Math.imul(hash ^ key[index], 0x01000193);
    hash ^= hash >>> 15;
  }
  return Math.imul(hash ^ (hash >>> 13), 0x5bd1e995) >>> 0;
}
