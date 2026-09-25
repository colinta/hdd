import {existsSync} from 'node:fs';
import React, {useEffect, useState} from 'react';
import {Button, Scrollable, Separator, Space, Spinner, Stack, Style, Text} from '@teaui/react';
import {
  formatBytes,
  formatElapsed,
  largestCandidates,
  type DiskUsageScanner,
  type FileInfo,
  type ProgressReport,
} from './disk-usage.js';
import {containingFolderLink, fileLink} from './terminal-link.js';

interface BuildInfo {
  version: string;
  commit: string;
  isDirty: boolean;
}

const buildInfoUrl = new URL('./build-info.generated.js', import.meta.url);
const buildInfo: BuildInfo | undefined = existsSync(buildInfoUrl)
  ? ((await import(buildInfoUrl.href)) as {buildInfo: BuildInfo}).buildInfo
  : undefined;

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

  const {directories: largestDirectories, files: largestFiles} = largestCandidates(
    progress,
    topCount,
  );

  return (
    <Stack.down>
      <Stack.down flex={1}>
        <Stack.right>
          <Text flex={1} bold>
            Hard disk usage report: {targetPath}
          </Text>
          {buildInfo ? (
            <>
              <Text dim foreground="gray">
                {buildInfo.version} - {buildInfo.commit}
                {buildInfo.isDirty ? (
                  <>
                    {' - '}
                    <Style dim foreground="red">X</Style>
                  </>
                ) : null}
              </Text>
              <Space width={1} />
            </>
          ) : null}
          <Button
            title="Rescan"
            onClick={() => {
              scanner.refresh();
              refreshReport();
            }}
          />
          {!progress.isComplete && !progress.isAborted ? (
            <Button
              title={progress.isPaused ? 'Resume' : 'Pause'}
              onClick={() => {
                if (progress.isPaused) {
                  scanner.resume();
                } else {
                  void scanner.pause();
                }
                refreshReport();
              }}
            />
          ) : null}
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

  if (progress.isPaused) {
    return (
      <Text italic>Status: Paused ({progress.pendingDirectories} directories remaining)</Text>
    );
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
    // TeaUI does not reliably move keyed host nodes, so keep each rendered row keyed
    // to its display position when the ranked entries are reordered.
    <Stack.right>
      <Stack.down>
        {entries.map((_, index) => (
          <Text alignment="right" key={index}>
            {index + 1}.{' '}
          </Text>
        ))}
      </Stack.down>
      <Stack.down flex={1}>
        {entries.map(([, info], index) => (
          <Text key={index}>
            {info.isDirectory
              ? fileLink(info.absolutePath, displayPath(info))
              : containingFolderLink(info.absolutePath, displayPath(info))}
          </Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map((_, index) => (
          <Text key={index}> | </Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map(([, info], index) => (
          <Text key={index}>{formatBytes(info.size).padStart(12)}</Text>
        ))}
      </Stack.down>
    </Stack.right>
  );
}

function Files({files, onRefresh}: {files: FileInfo[]; onRefresh(): void}) {
  // Expansion belongs to the whole browser, rather than to each recursively rendered level.
  // Rows are keyed by position for TeaUI, so a size change can move a directory to another row;
  // keeping the paths here prevents that move from remounting and collapsing its descendants.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  return (
    <FileRows
      files={files}
      expandedPaths={expandedPaths}
      onToggle={path =>
        setExpandedPaths(previous => {
          const next = new Set(previous);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        })
      }
      onRefresh={onRefresh}
    />
  );
}

// Entry views are created lazily, but rendering a directory with (say) 100k children would still
// build a TeaUI row for each one. Show the largest entries and summarize the rest.
const MAX_ROWS_PER_DIRECTORY = 500;

function FileRows({
  files,
  expandedPaths,
  onToggle,
  onRefresh,
}: {
  files: FileInfo[];
  expandedPaths: Set<string>;
  onToggle(path: string): void;
  onRefresh(): void;
}) {
  // Siblings share a parent path, so comparing names orders them like comparing paths.
  const sorted: FileInfo[] = [...files].sort(
    (a, b) => b.size - a.size || a.name.localeCompare(b.name),
  );

  if (!sorted.length) {
    return null;
  }

  const visible = sorted.slice(0, MAX_ROWS_PER_DIRECTORY);
  const hiddenCount = sorted.length - visible.length;
  const hiddenSize = sorted
    .slice(MAX_ROWS_PER_DIRECTORY)
    .reduce((total, fileInfo) => total + fileInfo.size, 0);

  return (
    <Stack.down>
      {visible.map((fileInfo, index) => {
        const summary = fileInfo.name + (fileInfo.isDirectory ? '/' : '');
        const isDirExpanded = fileInfo.isDirectory && expandedPaths.has(fileInfo.path);

        return (
          // TeaUI's renderer updates rows in place but does not reliably move keyed host nodes.
          // Key by display position so each row receives the entry from the newly sorted array.
          <Stack.down key={index}>
            <Stack.right>
              {fileInfo.isDirectory ? (
                <Button
                  border="none"
                  title={
                    (isDirExpanded ? '▾' : '▹') +
                    ' ' +
                    fileLink(fileInfo.absolutePath, summary)
                  }
                  onClick={() => onToggle(fileInfo.path)}
                />
              ) : (
                <Text>{'   ' + fileLink(fileInfo.absolutePath, summary) + ' '}</Text>
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
              {fileInfo.isDirectory && !fileInfo.aliasOf ? (
                <Text> ({fileInfo.childCount})</Text>
              ) : null}
              {fileInfo.aliasOf ? (
                <Text dim> (already counted at {fileInfo.aliasOf})</Text>
              ) : null}
              {!fileInfo.isComplete ? <Text> scanning…</Text> : null}
              {fileInfo.error ? <Text> ⚠ {fileInfo.error.message}</Text> : null}
            </Stack.right>
            {isDirExpanded ? (
              <Stack.right>
                <Space width={2} />
                <FileRows
                  files={fileInfo.children}
                  expandedPaths={expandedPaths}
                  onToggle={onToggle}
                  onRefresh={onRefresh}
                />
              </Stack.right>
            ) : null}
          </Stack.down>
        );
      })}
      {hiddenCount ? (
        <Text italic>
          {'   '}
          …and {hiddenCount} more ({formatBytes(hiddenSize)})
        </Text>
      ) : null}
    </Stack.down>
  );
}

function displayPath(info: FileInfo): string {
  return info.path || info.name;
}
