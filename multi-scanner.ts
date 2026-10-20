import {
  createDiskUsageScanner,
  type DiskUsageError,
  type DiskUsageScanner,
  type DiskUsageScannerOptions,
  type FileInfo,
  type LargestCandidates,
  type ProgressReport,
} from './disk-usage.js';

/** A top-level entry of one of the scanned folders, with the prefix that identifies its root. */
export interface RootEntry {
  /** `N/` when several folders are scanned, otherwise empty. */
  prefix: string;
  info: FileInfo;
}

/** The reports of every scanned folder, combined into one summary. */
export interface CombinedReport {
  roots: ProgressReport[];
  isMultiple: boolean;
  size: number;
  filesScanned: number;
  directoriesScanned: number;
  entriesScanned: number;
  pendingDirectories: number;
  /** Paths are prefixed with `N/` when several folders are scanned. */
  errors: DiskUsageError[];
  /** Every folder finished scanning. */
  isComplete: boolean;
  /** No folder is scanning, and at least one scan was aborted. */
  isAborted: boolean;
  /** No folder is actively scanning, and at least one is paused. */
  isPaused: boolean;
  startedAt: number;
  completedAt: number | null;
  elapsedMs: number;
  /** The top-level entries of every folder, unsorted. */
  children: RootEntry[];
  /** The largest entries across every folder; keys are prefixed with `N/` when needed. */
  largest(count: number): LargestCandidates;
}

export interface MultiScanner {
  scanners: DiskUsageScanner[];
  getReport(): CombinedReport;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  abort(): void;
  pause(): Promise<void>;
  resume(): void;
  wait(): Promise<CombinedReport>;
}

export function createMultiScanner(
  rootPaths: string[],
  options?: DiskUsageScannerOptions,
): MultiScanner {
  return multiScanner(rootPaths.map(rootPath => createDiskUsageScanner(rootPath, options)));
}

export function multiScanner(scanners: DiskUsageScanner[]): MultiScanner {
  const getReport = () => combineReports(scanners.map(scanner => scanner.getReport()));

  return {
    scanners,
    getReport,
    subscribe(listener) {
      const unsubscribes = scanners.map(scanner => scanner.subscribe(listener));
      return () => unsubscribes.forEach(unsubscribe => unsubscribe());
    },
    async refresh() {
      await Promise.all(scanners.map(scanner => scanner.refresh()));
    },
    abort() {
      scanners.forEach(scanner => scanner.abort());
    },
    async pause() {
      await Promise.all(scanners.map(scanner => scanner.pause()));
    },
    resume() {
      scanners.forEach(scanner => scanner.resume());
    },
    async wait() {
      await Promise.all(scanners.map(scanner => scanner.wait()));
      return getReport();
    },
  };
}

/** `N/` (1-based) when several folders are scanned, otherwise empty. */
export function rootPrefix(index: number, count: number): string {
  return count > 1 ? `${index + 1}/` : '';
}

/** Prefixes a path key (relative to its scan root, `.` for the root) with its root's prefix. */
export function prefixPath(prefix: string, path: string): string {
  if (!prefix) {
    return path;
  }
  return path === '.' || !path ? prefix : prefix + path;
}

export function combineReports(roots: ProgressReport[]): CombinedReport {
  const count = roots.length;
  const isMultiple = count > 1;
  const prefixes = roots.map((_, index) => rootPrefix(index, count));
  const sum = (value: (report: ProgressReport) => number) =>
    roots.reduce((total, report) => total + value(report), 0);

  const isScanning = (report: ProgressReport) =>
    !report.isComplete && !report.isAborted && !report.isPaused;
  const anyScanning = roots.some(isScanning);
  const startedAt = Math.min(...roots.map(report => report.startedAt));
  const endedAt = Math.max(...roots.map(report => report.startedAt + report.elapsedMs));
  const allCompleted = roots.every(report => report.completedAt !== null);

  return {
    roots,
    isMultiple,
    size: sum(report => report.size),
    filesScanned: sum(report => report.filesScanned),
    directoriesScanned: sum(report => report.directoriesScanned),
    entriesScanned: sum(report => report.entriesScanned),
    pendingDirectories: sum(report => report.pendingDirectories),
    errors: roots.flatMap((report, index) =>
      report.errors.map(error => ({...error, path: prefixPath(prefixes[index], error.path)})),
    ),
    isComplete: roots.every(report => report.isComplete),
    isAborted: !anyScanning && roots.some(report => report.isAborted),
    isPaused: !anyScanning && roots.some(report => report.isPaused),
    startedAt,
    completedAt: allCompleted ? endedAt : null,
    elapsedMs: endedAt - startedAt,
    get children() {
      return roots.flatMap((report, index) =>
        report.children.map(info => ({prefix: prefixes[index], info})),
      );
    },
    largest(limit) {
      if (!isMultiple) {
        return roots[0]?.largest(limit) ?? {directories: [], files: []};
      }
      const results = roots.map(report => report.largest(limit));
      const merge = (lists: [string, FileInfo][][]): [string, FileInfo][] =>
        lists
          .flatMap((list, index) =>
            list.map(([path, info]): [string, FileInfo] => [
              prefixPath(prefixes[index], path),
              info,
            ]),
          )
          .sort(([pathA, a], [pathB, b]) => b.size - a.size || pathA.localeCompare(pathB))
          .slice(0, limit);
      return {
        directories: merge(results.map(result => result.directories)),
        files: merge(results.map(result => result.files)),
      };
    },
  };
}
