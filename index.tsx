#!/usr/bin/env node
import React from 'react';
import {type Screen} from '@teaui/core';
import {run} from '@teaui/react';
import {resolve} from 'path';
import {App} from './App';
import {
  createDiskUsageScanner,
  formatBytes,
  formatElapsed,
  type DiskUsageScanner,
  type FileInfo,
  type ProgressReport,
} from './disk-usage';

interface CliOptions {
  printSummary: boolean;
  targetPath: string;
}

const options = parseCliArgs(process.argv.slice(2));
const targetPath = options.targetPath;
const scanner = createDiskUsageScanner(targetPath);

function parseCliArgs(args: string[]): CliOptions {
  const paths: string[] = [];
  let printSummary = false;

  for (const arg of args) {
    if (arg === '-p' || arg === '--print') {
      printSummary = true;
    } else {
      paths.push(arg);
    }
  }

  return {
    printSummary,
    targetPath: resolve(paths[0] || './'),
  };
}

async function printDiskUsageSummary(scanner: DiskUsageScanner): Promise<void> {
  const progress = await scanner.wait();
  const largestDirectories = largestEntries(progress, true, 10);
  const largestFiles = largestEntries(progress, false, 10);
  const status = progress.isAborted ? 'Aborted' : progress.isComplete ? 'Complete' : 'Incomplete';
  const lines = [
    `Hard disk usage report: ${progress.rootPath}`,
    `Status: ${status}`,
    `Total disk usage: ${formatBytes(progress.size)}`,
    `Scanned: ${progress.entriesScanned} entries (${progress.filesScanned} files, ${progress.directoriesScanned} directories)`,
    `Elapsed: ${formatElapsed(progress.elapsedMs)}`,
    `Warnings: ${progress.errors.length}`,
    '',
    ...formatEntrySection('Largest directories', largestDirectories, 'No directories scanned.'),
    '',
    ...formatEntrySection('Largest files', largestFiles, 'No files scanned.'),
  ];

  if (progress.errors.length) {
    lines.push('', 'Warnings');
    for (const warning of progress.errors.slice(0, 5)) {
      lines.push(`  ${warning.path}: ${warning.message}`);
    }
    if (progress.errors.length > 5) {
      lines.push(`  …and ${progress.errors.length - 5} more`);
    }
  }

  console.log(lines.join('\n'));

  if (progress.errors.some(error => error.path === progress.path)) {
    process.exitCode = 1;
  }
}

function largestEntries(
  progress: ProgressReport,
  isDirectory: boolean,
  count: number,
): [string, FileInfo][] {
  return Array.from(progress.files.entries())
    .filter(([path, info]) => path !== '.' && info.isDirectory === isDirectory)
    .sort(([, a], [, b]) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, count);
}

function formatEntrySection(
  title: string,
  entries: [string, FileInfo][],
  emptyLabel: string,
): string[] {
  const lines = [`${title}:`];

  if (!entries.length) {
    lines.push(`  ${emptyLabel}`);
    return lines;
  }

  for (const [, info] of entries) {
    const suffix = info.isDirectory ? '/' : '';
    lines.push(`  ${formatBytes(info.size).padStart(12)}  ${displayPath(info)}${suffix}`);
  }

  return lines;
}

function displayPath(info: FileInfo): string {
  return info.path || info.name;
}

let screen: Screen | undefined;

if (options.printSummary) {
  printDiskUsageSummary(scanner).catch(caught => {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  });
} else {
  (async () => {
    const [screen_] = await run(
      React.createElement(App, {
        scanner,
        targetPath,
        onExit() {
          scanner.abort();
          screen?.exit();
        },
      }),
    );
    screen = screen_;
  })();
}
