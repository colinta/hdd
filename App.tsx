import React, {useEffect, useState} from 'react';
import {Button, Scrollable, Separator, Space, Spinner, Stack, Text} from '@teaui/react';
import {
  formatBytes,
  formatElapsed,
  type DiskUsageScanner,
  type FileInfo,
  type ProgressReport,
} from './disk-usage';

export interface AppProps {
  scanner: DiskUsageScanner;
  targetPath: string;
  onExit(): void;
}

export function App({scanner, targetPath, onExit}: AppProps) {
  const [topCount, setTopCount] = useState(10);
  const [progress, setProgress] = useState<ProgressReport>(() => scanner.getReport());

  function refreshReport() {
    setProgress(scanner.getReport());
  }

  useEffect(() => {
    const unsubscribe = scanner.subscribe(() => {
      setProgress(scanner.getReport());
    });
    // Catch a scan update that may have completed between render and subscription.
    setProgress(scanner.getReport());
    return unsubscribe;
  }, [scanner]);

  const entries = Array.from(progress.files.entries()).filter(([path]) => path !== '.');
  const largestDirectories = entries
    .filter(([, info]) => info.isDirectory)
    .sort(([, a], [, b]) => b.size - a.size)
    .slice(0, topCount);
  const largestFiles = entries
    .filter(([, info]) => !info.isDirectory)
    .sort(([, a], [, b]) => b.size - a.size)
    .slice(0, topCount);

  return (
    <Stack.down>
      <Stack.down flex={1}>
        <Stack.right>
          <Text flex={1} bold>
            Hard disk usage report: {targetPath}
          </Text>
          <Button
            title="Rescan"
            onClick={() => {
              scanner.refresh();
              refreshReport();
            }}
          />
          {!progress.isComplete && !progress.isAborted ? (
            <Button
              title="Abort"
              onClick={() => {
                scanner.abort();
                refreshReport();
              }}
            />
          ) : null}
          <Button title="Exit" onClick={onExit} />
        </Stack.right>

        <StatusText progress={progress} />
        <Text italic>Total disk usage: {formatBytes(progress.size)}</Text>
        <Text italic>
          Scanned: {progress.entriesScanned} entries ({progress.filesScanned} files,{' '}
          {progress.directoriesScanned} directories)
        </Text>
        <Text italic>Elapsed: {formatElapsed(progress.elapsedMs)}</Text>
        {progress.errors.length ? (
          <Text>
            Warnings: {progress.errors.length} unreadable entries. First warning:{' '}
            {progress.errors[0]?.path}: {progress.errors[0]?.message}
          </Text>
        ) : null}

        <Separator direction="horizontal" border="single" />

        <Stack.right>
          <Text>Top </Text>
          <Button title="-" onClick={() => setTopCount(count => Math.max(1, count - 1))} />
          <Text bold> {topCount} </Text>
          <Button title="+" onClick={() => setTopCount(count => count + 1)} />
          <Text> largest entries</Text>
        </Stack.right>

        <Stack.right>
          <Stack.down flex={1}>
            <Text bold>Largest directories</Text>
            <Entries entries={largestDirectories} emptyLabel="No directories scanned yet." />
          </Stack.down>
          <Space width={4} />
          <Stack.down flex={1}>
            <Text bold>Largest files</Text>
            <Entries entries={largestFiles} emptyLabel="No files scanned yet." />
          </Stack.down>
        </Stack.right>

        <Separator direction="horizontal" border="single" />

        <Text bold>
          {progress.path} {formatBytes(progress.size)}
        </Text>
        <Scrollable>
          <Files files={progress.children} onRefresh={refreshReport} />
        </Scrollable>
      </Stack.down>
    </Stack.down>
  );
}

export function StatusText({progress}: {progress: ProgressReport}) {
  if (progress.isAborted) {
    return <Text italic>Status: Aborted</Text>;
  }

  if (progress.isComplete) {
    return <Text italic>Status: Complete</Text>;
  }

  return (
    <Stack.right>
      <Text italic>Status: </Text>
      <Spinner />
      <Text italic> Scanning ({progress.pendingDirectories} directories remaining)…</Text>
    </Stack.right>
  );
}

function Entries({
  entries,
  emptyLabel,
}: {
  entries: [string, FileInfo][];
  emptyLabel: string;
}) {
  if (!entries.length) {
    return <Text italic>{emptyLabel}</Text>;
  }

  return (
    <Stack.right>
      <Stack.down>
        {entries.map(([path], index) => (
          <Text alignment="right" key={path}>
            {index + 1}.{' '}
          </Text>
        ))}
      </Stack.down>
      <Stack.down flex={1}>
        {entries.map(([path, info]) => (
          <Text key={path}>{displayPath(info)}</Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map(([path]) => (
          <Text key={path}> | </Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map(([path, info]) => (
          <Text key={path}>{formatBytes(info.size).padStart(12)}</Text>
        ))}
      </Stack.down>
    </Stack.right>
  );
}

function Files({files, onRefresh}: {files: FileInfo[]; onRefresh(): void}) {
  const sorted: FileInfo[] = [...files].sort(
    (a, b) => b.size - a.size || a.path.localeCompare(b.path),
  );
  const [isExpanded, setExpanded] = useState<Map<string, boolean>>(new Map());

  if (!sorted.length) {
    return null;
  }

  return (
    <Stack.down>
      {sorted.map(fileInfo => {
        const summary = displayPath(fileInfo) + (fileInfo.isDirectory ? '/' : '');
        const isDirExpanded = fileInfo.isDirectory && isExpanded.get(fileInfo.path);

        return (
          <Stack.down key={fileInfo.path}>
            <Stack.right>
              {fileInfo.isDirectory ? (
                <Button
                  border="none"
                  title={(isDirExpanded ? '▾' : '▹') + ' ' + summary}
                  onClick={() =>
                    setExpanded(previous => {
                      const next = new Map(previous);
                      next.set(fileInfo.path, !next.get(fileInfo.path));
                      return next;
                    })
                  }
                />
              ) : (
                <Text>{'   ' + summary + ' '}</Text>
              )}
              {fileInfo.isDirectory ? (
                <Button
                  border="none"
                  title="↻"
                  onClick={() => {
                    void fileInfo.refresh();
                    onRefresh();
                  }}
                />
              ) : null}
              {fileInfo.isDirectory ? (
                <Button
                  border="none"
                  title="Ⓘ"
                  onClick={() => {
                    fileInfo.ignore();
                    onRefresh();
                  }}
                />
              ) : null}
              <Text italic> {formatBytes(fileInfo.size)}</Text>
              {fileInfo.isDirectory ? <Text> ({fileInfo.children.length})</Text> : null}
              {!fileInfo.isComplete ? <Text> scanning…</Text> : null}
              {fileInfo.error ? <Text> ⚠ {fileInfo.error.message}</Text> : null}
            </Stack.right>
            {isDirExpanded ? (
              <Stack.right>
                <Space width={2} />
                <Files files={fileInfo.children} onRefresh={onRefresh} />
              </Stack.right>
            ) : null}
          </Stack.down>
        );
      })}
    </Stack.down>
  );
}

function displayPath(info: FileInfo): string {
  return info.path || info.name;
}
