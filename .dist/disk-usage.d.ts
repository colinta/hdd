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
export interface ProgressReport extends FileInfo {
    files: Map<string, FileInfo>;
    error: Error | null;
}
export declare function analyzeDiskUsage(rootPath: string): () => ProgressReport;
export declare function formatBytes(bytes: number): string;
