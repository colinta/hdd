#!/usr/bin/env node
import React from 'react';
import {type Screen, interceptConsoleLog} from '@teaui/core';
import {run} from '@teaui/react';
import {readFileSync, statSync} from 'fs';
import {resolve} from 'path';
import {Command} from 'commander';
import {App} from './App.js';
import {formatBytes, formatElapsed, type FileInfo} from './disk-usage.js';
import {createMultiScanner, type MultiScanner} from './multi-scanner.js';
import {containingFolderLink, fileLink} from './terminal-link.js';

interface CliOptions {
  printSummary: boolean;
  targetPaths: string[];
}

const options = parseCliArgs(process.argv.slice(2));
const targetPaths = options.targetPaths;
const scanner = createMultiScanner(targetPaths);

function parseCliArgs(argv: string[]): CliOptions {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {version: string};

  const program = new Command()
    .name('hdd')
    .usage('[options] [folder...]')
    .description(
      'Visualize hard disk usage for one or more folders (defaults to the current folder).',
    )
    .argument('[folder...]', 'folders to scan')
    .option('-p, --print', 'print a summary instead of launching the interactive UI')
    .version(packageJson.version, '-v, --version', 'print the version and exit')
    .helpOption('-h, --help', 'show usage');

  program.parse(argv, {from: 'user'});
  const [folderArgs] = program.processedArgs as [string[] | undefined];
  const folders = folderArgs?.length ? folderArgs : ['./'];
  const targetPaths: string[] = [];

  for (const folder of folders) {
    const targetPath = resolve(folder);
    if (!isDirectory(targetPath)) {
      console.error(`error: '${folder}' is not a folder`);
      process.exit(-1);
    }
    if (!targetPaths.includes(targetPath)) {
      targetPaths.push(targetPath);
    }
  }

  return {
    printSummary: Boolean(program.opts().print),
    targetPaths,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function printDiskUsageSummary(scanner: MultiScanner): Promise<void> {
  const progress = await scanner.wait();
  const {directories: largestDirectories, files: largestFiles} = progress.largest(10);
  const status = progress.isAborted ? 'Aborted' : progress.isComplete ? 'Complete' : 'Incomplete';
  const lines = [
    `Hard disk usage report: ${progress.roots.map(root => root.rootPath).join(', ')}`,
    ...(progress.isMultiple
      ? progress.roots.map(
          (root, index) => `  ${index + 1}. ${root.rootPath} ${formatBytes(root.size)}`,
        )
      : []),
    `Status: ${status}`,
    `Total disk usage: ${formatBytes(progress.size)}`,
    `Scanned: ${progress.entriesScanned.toLocaleString('en-US')} entries (${progress.filesScanned.toLocaleString('en-US')} files, ${progress.directoriesScanned.toLocaleString('en-US')} directories)`,
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

  // A folder that could not be scanned at all reports its error at the root.
  if (progress.roots.some(root => root.errors.some(error => error.path === '.'))) {
    process.exitCode = 1;
  }
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

  for (const [path, info] of entries) {
    const suffix = info.isDirectory ? '/' : '';
    const title = `${path || info.name}${suffix}`;
    const link = info.isDirectory
      ? fileLink(info.absolutePath, title)
      : containingFolderLink(info.absolutePath, title);
    lines.push(`  ${formatBytes(info.size).padStart(12)}  ${link}`);
  }

  return lines;
}

let screen: Screen | undefined;

if (options.printSummary) {
  printDiskUsageSummary(scanner).catch(caught => {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  });
} else {
  (async () => {
    interceptConsoleLog()
    const [screen_] = await run(
      React.createElement(App, {
        scanner,
        targetPaths,
        onExit() {
          scanner.abort();
          screen?.exit();
        },
      }),
      // App registers its own Ctrl-C hotkey, so that Ctrl-C reaches the embedded
      // shell while the terminal modal is open.
      {quitChar: false},
    );
    screen = screen_;
  })();
}
