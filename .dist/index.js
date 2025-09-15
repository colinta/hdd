#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importStar(require("react"));
const core_1 = require("@teaui/core");
const react_2 = require("@teaui/react");
const disk_usage_1 = require("./disk-usage");
const path_1 = require("path");
(0, core_1.interceptConsoleLog)();
const targetPath = process.argv[2] || (0, path_1.resolve)('./');
const getProgress = (0, disk_usage_1.analyzeDiskUsage)(targetPath);
function App() {
    function onExit() {
        screen?.exit();
    }
    const [spinner, spin] = (0, react_1.useState)(0);
    const [inProgress, setInProgress] = (0, react_1.useState)(true);
    const [progress, setProgress] = (0, react_1.useState)({
        children: [],
        files: new Map(),
        size: 0,
        isComplete: false,
        error: null,
        path: '',
        isDirectory: true,
        async refresh() { },
        recalculate() { },
        abort() { },
    });
    (0, react_1.useEffect)(() => {
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
    const [max, setMax] = (0, react_1.useState)(1);
    const sortedEntries = Array.from(progress.files.entries())
        .filter(([, info]) => info.isDirectory)
        .sort(([, a], [, b]) => b.size - a.size)
        .slice(0, max);
    return (react_1.default.createElement(react_2.Stack.down, null,
        react_1.default.createElement(react_2.Stack.down, { flex: 1 },
            progress.error ? react_1.default.createElement(react_2.Text, null, progress.error.toString()) : null,
            react_1.default.createElement(react_2.Stack.right, null,
                react_1.default.createElement(react_2.Text, { flex: 1, italic: true },
                    "Analyzing disk usage for: ",
                    progress.isComplete ? targetPath : progress.path),
                react_1.default.createElement(react_2.Button, { title: "Exit", onClick: onExit })),
            react_1.default.createElement(react_2.Text, { italic: true },
                "Status:",
                ' ',
                progress.isComplete ? 'Complete' : STATUS[spinner % STATUS.length] + 'In Progress...'),
            react_1.default.createElement(react_2.Text, { italic: true },
                "Total size: ",
                (0, disk_usage_1.formatBytes)(progress.size)),
            react_1.default.createElement(react_2.Text, { italic: true },
                "Files analyzed: ",
                progress.files.size),
            react_1.default.createElement(react_2.Separator, { direction: "horizontal", border: "single" }),
            sortedEntries.length ? (react_1.default.createElement(react_1.default.Fragment, null,
                react_1.default.createElement(react_2.Stack.right, null,
                    react_1.default.createElement(react_2.Text, null, "Top "),
                    react_1.default.createElement(react_2.Button, { title: "-", onClick: () => setMax(max => Math.max(1, max - 1)) }),
                    react_1.default.createElement(react_2.Text, { bold: true },
                        " ",
                        sortedEntries.length,
                        " "),
                    react_1.default.createElement(react_2.Button, { title: "+", onClick: () => setMax(max => max + 1) }),
                    ' ',
                    react_1.default.createElement(react_2.Text, null, " largest items")),
                react_1.default.createElement(Entries, { entries: sortedEntries }))) : null,
            react_1.default.createElement(react_2.Separator, { direction: "horizontal", border: "single" }),
            react_1.default.createElement(react_2.Stack.right, null,
                react_1.default.createElement(react_2.Text, { italic: true },
                    progress.path,
                    " ",
                    (0, disk_usage_1.formatBytes)(progress.size)),
                react_1.default.createElement(react_2.Button, { border: "none", title: "\uD83D\uDD04", onClick: () => {
                        progress.refresh();
                        setInProgress(true);
                    } })),
            react_1.default.createElement(react_2.Scrollable, null,
                react_1.default.createElement(Files, { onRefresh: () => {
                        setInProgress(true);
                    }, files: progress.children }))),
        react_1.default.createElement(react_2.Collapsible, { isCollapsed: true, collapsed: react_1.default.createElement(react_2.Text, null, "Show Console"), expanded: react_1.default.createElement(react_2.ConsoleLog, { height: 10 }) })));
}
function Entries({ entries }) {
    return (react_1.default.createElement(react_2.Stack.right, null,
        react_1.default.createElement(react_2.Stack.down, null, entries.map(([path], index) => (react_1.default.createElement(react_2.Text, { alignment: "right", key: path },
            index + 1,
            ".",
            ' ')))),
        react_1.default.createElement(react_2.Stack.down, null, entries.map(([path, info]) => (react_1.default.createElement(react_2.Text, { key: path }, path)))),
        react_1.default.createElement(react_2.Stack.down, null, entries.map(([path, info]) => (react_1.default.createElement(react_2.Text, { key: path }, " | ")))),
        react_1.default.createElement(react_2.Stack.down, null, entries.map(([path, info]) => (react_1.default.createElement(react_2.Text, { key: path }, (0, disk_usage_1.formatBytes)(info.size).padEnd(12)))))));
}
function Files({ files, onRefresh }) {
    const sorted = [...files].sort((a, b) => b.size - a.size);
    const [isExpanded, setExpanded] = (0, react_1.useState)(new Map());
    return (react_1.default.createElement(react_2.Stack.down, null, sorted.map(fileInfo => {
        const summary = fileInfo.path + (fileInfo.isDirectory ? '/' : '');
        const isDirExpanded = fileInfo.isDirectory && isExpanded.get(fileInfo.path);
        return (react_1.default.createElement(react_2.Stack.down, { key: fileInfo.path },
            react_1.default.createElement(react_2.Stack.right, null,
                fileInfo.isDirectory ? (react_1.default.createElement(react_2.Button, { border: "none", title: (isDirExpanded ? '▾' : '▹') + ' ' + summary, onClick: () => setExpanded(info => {
                        info.set(fileInfo.path, !info.get(fileInfo.path));
                        return new Map(info);
                    }) })) : (react_1.default.createElement(react_2.Text, null, '   ' + summary + ' ')),
                react_1.default.createElement(react_2.Text, { italic: true },
                    " ",
                    (0, disk_usage_1.formatBytes)(fileInfo.size)),
                react_1.default.createElement(react_2.Text, null,
                    " (",
                    fileInfo.children.length,
                    ")"),
                react_1.default.createElement(react_2.Button, { border: "none", title: "\uD83D\uDD04", onClick: () => {
                        fileInfo.refresh();
                        onRefresh();
                    } })),
            isDirExpanded ? (react_1.default.createElement(react_2.Stack.right, null,
                react_1.default.createElement(react_2.Space, { width: 2 }),
                react_1.default.createElement(Files, { onRefresh: onRefresh, files: fileInfo.children }))) : null));
    })));
}
let screen;
(async () => {
    const [screen_] = await (0, react_2.run)(react_1.default.createElement(App, null));
    screen = screen_;
})();
const STATUS = ['⠋ ', '⠙ ', '⠹ ', '⠸ ', '⠼ ', '⠴ ', '⠦ ', '⠧ ', '⠇ ', '⠏ '];
//# sourceMappingURL=index.js.map