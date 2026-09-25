import {promises as fs} from 'node:fs';

/**
 * The subset of `fs.Stats` used by the disk usage scanner. `lstat` semantics are expected:
 * symbolic links describe the link itself rather than its target.
 */
export interface FileSystemStats {
  /** Apparent size in bytes. */
  size: number;
  /** Allocated 512-byte blocks, when the platform reports them. */
  blocks?: number;
  /**
   * Device and inode numbers, when available. The scanner uses them to count a directory that
   * is reachable through several paths (such as macOS firmlinks or bind mounts) only once.
   * Values must be exact: use a bigint when a number would exceed `Number.MAX_SAFE_INTEGER`.
   */
  dev?: number | bigint;
  ino?: number | bigint;
  isDirectory(): boolean;
}

export interface FileSystemDirectoryEntry {
  name: string;
}

/** An open directory handle, equivalent to the subset of `fs.Dir` used by the scanner. */
export interface FileSystemDirectory {
  /** The path passed to `opendir`. */
  readonly path: string;
  /** Resolves the next entry, or `null` once every entry has been read. */
  read(): Promise<FileSystemDirectoryEntry | null>;
  close(): Promise<void>;
}

export interface FileSystem {
  lstat(path: string): Promise<FileSystemStats>;
  opendir(path: string): Promise<FileSystemDirectory>;
}

export const nodeFileSystem: FileSystem = {
  async lstat(path) {
    const stats = await fs.lstat(path);
    if (
      stats.isDirectory() &&
      !(Number.isSafeInteger(stats.dev) && Number.isSafeInteger(stats.ino))
    ) {
      // Number stats round large inode numbers (APFS uses some), which could make distinct
      // directories look identical. Re-read exact values only when they are needed.
      const exact = await fs.lstat(path, {bigint: true});
      return {
        size: stats.size,
        blocks: stats.blocks,
        dev: exact.dev,
        ino: exact.ino,
        isDirectory: () => exact.isDirectory(),
      };
    }
    return stats;
  },
  opendir: path => fs.opendir(path),
};
