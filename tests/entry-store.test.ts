import {Buffer} from 'node:buffer';
import {describe, expect, it} from 'vitest';
import {
  COMPLETE,
  DIRECTORY,
  DirectoryIdentityTable,
  EntryStore,
  IDENTITY_KEEP,
  IDENTITY_MATCH,
  IDENTITY_STALE,
  NONE,
  readDirectoryIdentity,
  type IdentityClassification,
} from '../entry-store.js';

function childNames(store: EntryStore, parent: number): string[] {
  const names: string[] = [];
  for (let child = store.firstChild(parent); child !== NONE; child = store.nextSibling(child)) {
    names.push(store.name(child));
  }
  return names;
}

function buildTree(store: EntryStore): {root: number; a: number; b: number; c: number} {
  const root = store.allocate('', NONE, DIRECTORY, 0);
  const a = store.allocate('a', root, DIRECTORY, 10);
  store.prependChild(root, a);
  const b = store.allocate('b', a, 0, 20);
  store.prependChild(a, b);
  const c = store.allocate('c', root, 0, 30);
  store.prependChild(root, c);
  return {root, a, b, c};
}

describe('EntryStore', () => {
  it('stores entries with names, sizes, flags, and child lists', () => {
    const store = new EntryStore();
    const {root, a, b} = buildTree(store);

    expect(store.name(a)).toBe('a');
    expect(store.size(b)).toBe(20);
    expect(store.parent(b)).toBe(a);
    expect(store.flags(a) & DIRECTORY).toBe(DIRECTORY);
    expect(childNames(store, root)).toEqual(['c', 'a']);
    expect(store.findChild(root, Buffer.from('a'))).toBe(a);
    expect(store.findChild(root, Buffer.from('missing'))).toBe(NONE);
    expect(store.liveEntries).toBe(4);

    store.addFlags(a, COMPLETE);
    expect(store.flags(a) & COMPLETE).toBe(COMPLETE);
    store.clearFlags(a, COMPLETE);
    expect(store.flags(a) & COMPLETE).toBe(0);
  });

  it('round-trips non-ASCII names', () => {
    const store = new EntryStore();
    const id = store.allocate('résumé 📄.pdf', NONE, 0, 1);

    expect(store.name(id)).toBe('résumé 📄.pdf');
    expect(store.nameEquals(id, Buffer.from('résumé 📄.pdf'))).toBe(true);
    expect(store.nameBytes).toBe(Buffer.byteLength('résumé 📄.pdf'));
  });

  it('unlinks and replaces children in place', () => {
    const store = new EntryStore();
    const {root, a, c} = buildTree(store);
    const d = store.allocate('d', NONE, 0, 1);

    expect(store.replaceChild(root, a, d)).toBe(true);
    expect(childNames(store, root)).toEqual(['c', 'd']);
    expect(store.parent(d)).toBe(root);
    expect(store.unlinkChild(root, c)).toBe(true);
    expect(childNames(store, root)).toEqual(['d']);
    expect(store.unlinkChild(root, c)).toBe(false);
  });

  it('visits a subtree without leaving it', () => {
    const store = new EntryStore();
    const {root, a, b} = buildTree(store);
    const visited: number[] = [];

    store.forEachInSubtree(a, id => visited.push(id));
    expect(visited).toEqual([a, b]);

    visited.length = 0;
    store.forEachInSubtree(root, id => visited.push(id));
    expect(visited).toHaveLength(4);
  });

  it('releases subtrees, invalidates their references, and reuses their slots', () => {
    const store = new EntryStore();
    const {root, a, b, c} = buildTree(store);
    const generation = store.generation(b);
    const released: number[] = [];

    store.unlinkChild(root, a);
    store.releaseSubtree(a, id => released.push(id));

    expect(released).toEqual([b, a]);
    expect(store.liveEntries).toBe(2);
    expect(store.isLive(b, generation)).toBe(false);
    expect(store.isLive(c, store.generation(c))).toBe(true);
    expect(childNames(store, root)).toEqual(['c']);

    const reused = [store.allocate('x', root, 0, 1), store.allocate('y', root, 0, 1)];
    expect(reused.sort()).toEqual([a, b].sort());
    // The reused slot has a new generation, so the old reference stays invalid.
    expect(store.isLive(b, generation)).toBe(false);
    expect(store.entryCapacity).toBe(65_536);
  });

  it('compacts name storage once released names dominate it', () => {
    const store = new EntryStore({nameCompactionMinBytes: 1024});
    const root = store.allocate('', NONE, DIRECTORY, 0);
    const keep = store.allocate('keep-me', root, 0, 1);
    store.prependChild(root, keep);

    for (let round = 0; round < 20; round++) {
      const directory = store.allocate(`directory-${round}`, root, DIRECTORY, 0);
      store.prependChild(root, directory);
      for (let index = 0; index < 20; index++) {
        const file = store.allocate(`some-long-file-name-${round}-${index}`, directory, 0, 1);
        store.prependChild(directory, file);
      }
      store.unlinkChild(root, directory);
      store.releaseSubtree(directory);
    }

    expect(store.name(keep)).toBe('keep-me');
    expect(store.nameBytes).toBe('keep-me'.length);
    // Without compaction the arena would hold every name ever written (over 10 KB).
    expect(store.nameCapacityBytes).toBeLessThanOrEqual(4096);
  });
});

describe('readDirectoryIdentity', () => {
  it('splits exact device and inode numbers into 32-bit words', () => {
    const out = new Uint32Array(4);
    expect(readDirectoryIdentity({dev: 16_777_232, ino: 1_152_921_500_311_879_682n}, out)).toBe(
      true,
    );
    expect([...out]).toEqual([0, 16_777_232, 268_435_455, 2]);
  });

  it('rejects missing, zero, and inexact inode numbers', () => {
    const out = new Uint32Array(4);
    expect(readDirectoryIdentity({}, out)).toBe(false);
    expect(readDirectoryIdentity({dev: 1, ino: 0}, out)).toBe(false);
    expect(readDirectoryIdentity({dev: 1, ino: 2 ** 60}, out)).toBe(false);
    expect(readDirectoryIdentity({dev: 0, ino: 5}, out)).toBe(true);
  });
});

describe('DirectoryIdentityTable', () => {
  const identity = (ino: number) => {
    const out = new Uint32Array(4);
    readDirectoryIdentity({dev: 1, ino}, out);
    return out;
  };

  it('finds current owners and drops stale ones', () => {
    const states = new Map<number, IdentityClassification>();
    const table = new DirectoryIdentityTable(id => states.get(id) ?? IDENTITY_STALE);

    states.set(10, IDENTITY_MATCH);
    table.insert(identity(100), 10, 0);
    expect(table.find(identity(100))).toBe(10);
    expect(table.find(identity(101))).toBe(NONE);

    // A kept-aside owner does not match, but is retained alongside its replacement.
    states.set(10, IDENTITY_KEEP);
    expect(table.find(identity(100))).toBe(NONE);
    states.set(11, IDENTITY_MATCH);
    table.insert(identity(100), 11, 0);
    expect(table.find(identity(100))).toBe(11);

    states.set(11, IDENTITY_STALE);
    states.set(10, IDENTITY_MATCH);
    expect(table.find(identity(100))).toBe(10);
  });

  it('grows while discarding stale entries', () => {
    const live = new Set<number>();
    const table = new DirectoryIdentityTable(id =>
      live.has(id) ? IDENTITY_MATCH : IDENTITY_STALE,
    );

    for (let id = 1; id <= 10_000; id++) {
      table.insert(identity(id), id, 0);
      if (id % 10 === 0) {
        live.add(id);
      }
    }

    expect(table.find(identity(5_000))).toBe(5_000);
    expect(table.find(identity(5_001))).toBe(NONE);
    // Stale entries are dropped on rebuild, so the table tracks live directories.
    expect(table.capacity).toBeLessThan(16_384);
  });
});
