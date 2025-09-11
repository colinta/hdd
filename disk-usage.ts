import {promises as fs} from 'fs';
import {join, relative} from 'path';

export interface FileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
  isComplete: boolean;
  children: FileInfo[];
  refresh(): Promise<void>;
  recalculate(): void;
  abort(): void;
}

interface FileInfoJob extends FileInfo {
  setIsComplete(isComplete: boolean): void;
  isAborted: boolean;
}

export interface ProgressReport extends FileInfo {
  files: Map<string, FileInfo>;
  error: Error | null;
}

export function analyzeDiskUsage(rootPath: string): () => ProgressReport {
  const fileMap: Map<string, FileInfoJob> = new Map();
  let error: Error | null = null;

  async function scanDirectory(dirPath: string, cwdInfo: FileInfoJob): Promise<void> {
    cwdInfo.isAborted = false;
    cwdInfo.isComplete = false;
    cwdInfo.size = 0;
    cwdInfo.children = [];

    const entries = await fs.readdir(dirPath, {withFileTypes: true});
    const promises = entries.map(async entry => {
      if (cwdInfo.isAborted) {
        return;
      }

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        const dirInfo: FileInfoJob = {
          path: relPath,
          size: 0,
          isDirectory: true,
          isComplete: false,
          children: [],
          isAborted: false,
          setIsComplete(isComplete: boolean) {
            dirInfo.isComplete = isComplete;
            cwdInfo.setIsComplete(isComplete);
          },
          abort() {
            dirInfo.isAborted = true;
            for (const info of dirInfo.children) {
              info.abort();
            }
          },
          async refresh() {
            dirInfo.setIsComplete(false);
            for (const info of dirInfo.children) {
              info.abort();
              fileMap.delete(info.path);
            }

            // if fullPath still exists, scan it, otherwise remove from fileMap
            const pathExists = await fs
              .stat(fullPath)
              .then(() => true)
              .catch(() => false);
            if (pathExists) {
              await scanDirectory(fullPath, dirInfo);
              cwdInfo.recalculate();
            } else {
              fileMap.delete(relPath);
              cwdInfo.refresh();
            }
            dirInfo.setIsComplete(true);
          },
          recalculate() {
            dirInfo.size = dirInfo.children.reduce((acc, child) => acc + child.size, 0);
            cwdInfo.recalculate();
          },
        };
        fileMap.set(relPath, dirInfo);

        await dirInfo.refresh();
        cwdInfo.children.push(dirInfo);
        cwdInfo.size += dirInfo.size;
      } else if (entry.isFile()) {
        const stats = await fs.stat(fullPath);
        const fileSize = stats.size;
        const fileInfo: FileInfoJob = {
          path: relative(rootPath, fullPath),
          size: fileSize,
          isDirectory: false,
          isComplete: true,
          children: [],
          isAborted: false,
          setIsComplete(isComplete: boolean) {
            fileInfo.isComplete = isComplete;
            cwdInfo.setIsComplete(isComplete);
          },
          abort() {
            fileInfo.isAborted = true;
          },
          async refresh() {
            fileInfo.setIsComplete(false);
            const pathExists = await fs
              .stat(fullPath)
              .then(() => true)
              .catch(() => false);
            if (pathExists) {
              const stats = await fs.stat(fullPath);
              fileInfo.size = stats.size;
            } else {
              fileMap.delete(relPath);
              cwdInfo.refresh();
            }
            cwdInfo.recalculate();
            fileInfo.setIsComplete(true);
          },
          recalculate() {
            fileInfo.refresh();
          },
        };
        fileMap.set(relPath, fileInfo);

        cwdInfo.size += fileSize;
        cwdInfo.children.push(fileInfo);
      }
    });

    await Promise.allSettled(promises).then(result => {
      const caught = result.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (caught) {
        error = caught.reason;
      }
    });

    cwdInfo.isComplete = true;
  }

  const rootInfo: FileInfoJob = {
    path: rootPath,
    size: 0,
    isDirectory: true,
    isComplete: false,
    children: [],
    isAborted: false,
    setIsComplete(isComplete: boolean) {
      rootInfo.isComplete = isComplete;
    },
    abort() {
      rootInfo.isAborted = true;
    },
    async refresh() {
      for (const [path, info] of fileMap) {
        if (info === rootInfo) {
          continue;
        }

        info.abort();
        fileMap.delete(path);
      }

      scanDirectory(rootPath, rootInfo).catch(caught => {
        error = caught;
        console.error('Error during disk analysis:', caught);
      });
    },
    recalculate() {
      rootInfo.size = rootInfo.children.reduce((acc, child) => acc + child.size, 0);
    },
  };
  rootInfo.refresh();

  return () => ({
    error,
    files: new Map(fileMap),
    // FileInfo
    path: rootInfo.path,
    isDirectory: rootInfo.isDirectory,
    size: rootInfo.size,
    children: rootInfo.children,
    isComplete: rootInfo.isComplete,
    refresh() {
      return rootInfo.refresh();
    },
    recalculate() {
      return rootInfo.recalculate();
    },
    abort() {
      return rootInfo.abort();
    },
  });
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, power);

  return `${size.toFixed(2)} ${units[power]}`;
}
