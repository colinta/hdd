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
  lstat: path => fs.lstat(path),
  opendir: path => fs.opendir(path),
};
