import React, {useEffect, useState} from 'react';
import {interceptConsoleLog, type Screen} from '@teaui/core';
import {
  Button,
  Collapsible,
  ConsoleLog,
  Separator,
  Scrollable,
  Stack,
  Space,
  Text,
  run,
} from '@teaui/react';
import {analyzeDiskUsage, formatBytes, type ProgressReport, type FileInfo} from './disk-usage';
import {resolve} from 'path';

interceptConsoleLog();

const targetPath = process.argv[2] || resolve('./');
const getProgress = analyzeDiskUsage(targetPath);

function App() {
  function onExit() {
    screen?.exit();
  }

  const [spinner, spin] = useState(0);
  const [inProgress, setInProgress] = useState(true);
  const [progress, setProgress] = useState<ProgressReport>({
    children: [],
    files: new Map(),
    size: 0,
    isComplete: false,
    error: null,
    path: '',
    isDirectory: true,
    async refresh() {},
    recalculate() {},
    abort() {},
  });

  useEffect(() => {
    if (!inProgress) {
      return;
    }

    const interval = setInterval(() => {
      const progress = getProgress();
      setProgress(progress);
      setInProgress(!progress.isComplete);

      spin(i => i + 1);
      if (progress.isComplete) {
        clearInterval(interval);
      }
    }, 100);

    return () => {
      clearInterval(interval);
    };
  }, [inProgress]);

  const [max, setMax] = useState(1);
  const sortedEntries: [string, FileInfo][] = Array.from(progress.files.entries())
    .filter(([, info]) => info.isDirectory)
    .sort(([, a], [, b]) => b.size - a.size)
    .slice(0, max);

  return (
    <Stack.down>
      <Stack.down flex={1}>
        {progress.error ? <Text>{progress.error.toString()}</Text> : null}
        <Stack.right>
          <Text flex={1} italic>
            Analyzing disk usage for: {progress.isComplete ? targetPath : progress.path}
          </Text>
          <Button title="Exit" onClick={onExit} />
        </Stack.right>
        <Text italic>
          Status:{' '}
          {progress.isComplete ? 'Complete' : STATUS[spinner % STATUS.length] + 'In Progress...'}
        </Text>
        <Text italic>Total size: {formatBytes(progress.size)}</Text>
        <Text italic>Files analyzed: {progress.files.size}</Text>
        <Separator direction="horizontal" border="single" />
        {sortedEntries.length ? (
          <>
            <Stack.right>
              <Text>Top </Text>
              <Button title="-" onClick={() => setMax(max => Math.max(1, max - 1))} />
              <Text bold> {sortedEntries.length} </Text>
              <Button title="+" onClick={() => setMax(max => max + 1)} />{' '}
              <Text> largest items</Text>
            </Stack.right>
            <Entries entries={sortedEntries} />
          </>
        ) : null}
        <Separator direction="horizontal" border="single" />
        <Stack.right>
          <Text italic>
            {progress.path} {formatBytes(progress.size)}
          </Text>
          <Button
            border="none"
            title="🔄"
            onClick={() => {
              progress.refresh();
              setInProgress(true);
            }}
          />
        </Stack.right>
        <Scrollable>
          <Files
            onRefresh={() => {
              setInProgress(true);
            }}
            files={progress.children}
          />
        </Scrollable>
      </Stack.down>
      <Collapsible
        isCollapsed
        collapsed={<Text>Show Console</Text>}
        expanded={<ConsoleLog height={10} />}
      />
    </Stack.down>
  );
}

function Entries({entries}: {entries: [string, FileInfo][]}) {
  return (
    <Stack.right>
      <Stack.down>
        {entries.map(([path], index) => (
          <Text alignment="right" key={path}>
            {index + 1}.{' '}
          </Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map(([path, info]) => (
          <Text key={path}>{path}</Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map(([path, info]) => (
          <Text key={path}> | </Text>
        ))}
      </Stack.down>
      <Stack.down>
        {entries.map(([path, info]) => (
          <Text key={path}>{formatBytes(info.size).padEnd(12)}</Text>
        ))}
      </Stack.down>
    </Stack.right>
  );
}

function Files({files, onRefresh}: {files: FileInfo[]; onRefresh: () => void}) {
  const sorted: FileInfo[] = [...files].sort((a, b) => b.size - a.size);
  const [isExpanded, setExpanded] = useState<Map<string, boolean>>(new Map());

  return (
    <Stack.down>
      {sorted.map(fileInfo => {
        const summary = fileInfo.path + (fileInfo.isDirectory ? '/' : '');
        const isDirExpanded = fileInfo.isDirectory && isExpanded.get(fileInfo.path);

        return (
          <Stack.down key={fileInfo.path}>
            <Stack.right>
              {fileInfo.isDirectory ? (
                <Button
                  border="none"
                  title={(isDirExpanded ? '▾' : '▹') + ' ' + summary}
                  onClick={() =>
                    setExpanded(info => {
                      info.set(fileInfo.path, !info.get(fileInfo.path));
                      return new Map(info);
                    })
                  }
                />
              ) : (
                <Text>{'   ' + summary + ' '}</Text>
              )}
              <Text italic> {formatBytes(fileInfo.size)}</Text>
              <Text> ({fileInfo.children.length})</Text>
              <Button
                border="none"
                title="🔄"
                onClick={() => {
                  fileInfo.refresh();
                  onRefresh();
                }}
              />
            </Stack.right>
            {isDirExpanded ? (
              <Stack.right>
                <Space width={2} />
                <Files onRefresh={onRefresh} files={fileInfo.children} />
              </Stack.right>
            ) : null}
          </Stack.down>
        );
      })}
    </Stack.down>
  );
}

let screen: Screen | undefined;
(async () => {
  const [screen_] = await run(<App />);
  screen = screen_;
})();

const STATUS = ['⠋ ', '⠙ ', '⠹ ', '⠸ ', '⠼ ', '⠴ ', '⠦ ', '⠧ ', '⠇ ', '⠏ '];
