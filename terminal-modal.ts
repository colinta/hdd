import {
  Box,
  Button,
  Container,
  Modal,
  Size,
  Space,
  Stack,
  Style,
  Text,
  View,
  type HotKeyDef,
  type KeyEvent,
  type Screen,
  type ViewProps,
  type Viewport,
} from '@teaui/core';
import {registerElement} from '@teaui/react';
import {Subprocess} from '@teaui/subprocess';
import {userInfo} from 'node:os';
import React from 'react';

export interface TerminalModalProps extends ViewProps {
  /** Working directory for the shell. */
  cwd: string;
  /** Called when the user closes the modal, or when the shell exits. */
  onClose(): void;
}

// The FocusManager treats tab/shift-tab as "move focus", which would make shell
// completion impossible. Hotkeys are matched before that, so claim them here.
const TAB: HotKeyDef = {char: 'tab', shift: false};
const SHIFT_TAB: HotKeyDef = {char: 'tab', shift: true};

/**
 * Forwards tab/shift-tab to the shell, and gives the shell keyboard focus the
 * first time the modal is shown.
 */
class TerminalKeys extends Container {
  #subprocess: Subprocess;
  #didFocus = false;

  constructor(subprocess: Subprocess, child: View) {
    super({children: [child]});
    this.#subprocess = subprocess;
  }

  naturalSize(available: Size): Size {
    return available;
  }

  receiveKey(event: KeyEvent): void {
    this.#subprocess.receiveKey(event);
  }

  render(viewport: Viewport): void {
    if (!viewport.isEmpty) {
      viewport.registerHotKey(TAB);
      viewport.registerHotKey(SHIFT_TAB);
      if (!this.#didFocus && this.screen) {
        this.#didFocus = true;
        this.screen.requestFocus(this.#subprocess);
      }
    }
    super.render(viewport);
  }
}

/**
 * Takes no space in the layout; while mounted it presents a modal containing an
 * interactive shell running in `cwd`. Unmounting it kills the shell.
 */
export class TerminalModal extends View {
  #onClose: () => void;
  #modal: Modal;

  constructor({cwd, onClose}: TerminalModalProps) {
    super({});
    this.#onClose = onClose;

    const shell = loginShell();
    const subprocess = new Subprocess({
      command: shell.command,
      args: shell.args,
      cwd,
      onExit: () => this.#onClose(),
    });

    const header = Stack.right([
      [
        'flex1',
        new Text({
          text: ' exit or Ctrl-D to return to hdd ',
          style: new Style({italic: true, dim: true}),
        }),
      ],
      new Button({border: 'none', title: '✕ Close', onClick: () => this.#onClose()}),
    ]);

    this.#modal = new Modal({
      dim: true,
      // Escape and clicks belong to the shell (vim, less, etc.), not the modal.
      dismissOnEsc: false,
      dismissOnClick: false,
      children: [
        new TerminalKeys(
          subprocess,
          // Right half of the screen, so the (dimmed) tree stays visible on the left.
          Stack.right({
            padding: 2,
            children: [
              ['flex1', new Space()],
              [
                'flex1',
                new Box({
                  border: 'rounded',
                  title: ` ${cwd} `,
                  children: [Stack.down([header, ['flex1', subprocess]])],
                }),
              ],
            ],
          }),
        ),
      ],
    });
  }

  update(props: TerminalModalProps): void {
    // cwd is fixed for the life of the shell; remount (via `key`) to change it.
    const {cwd: _cwd, onClose, ...viewProps} = props;
    this.#onClose = onClose;
    super.update(viewProps);
  }

  naturalSize(): Size {
    return Size.zero;
  }

  render(viewport: Viewport): void {
    viewport.requestModal(this.#modal);
  }

  didUnmount(screen: Screen): void {
    super.didUnmount(screen);
    // The modal isn't one of our children, so unmount it (and kill the shell) ourselves.
    this.#modal.moveToScreen(undefined);
  }
}

/**
 * The user's login shell (as set by `chsh`), started as an interactive login shell so that it
 * loads the same startup files as a new terminal window (.bash_profile, .zprofile + .zshrc, …).
 * It runs in a pty, so it is interactive without `-i`.
 */
function loginShell(): {command: string; args: string[]} {
  if (process.platform === 'win32') {
    return {command: process.env.COMSPEC || 'cmd.exe', args: []};
  }

  // `userInfo().shell` comes from the user database (what `chsh` changes), whereas $SHELL can
  // be stale or overridden by whatever launched hdd.
  let shell: string | null = null;
  try {
    shell = userInfo().shell;
  } catch {
    // No user database entry (e.g. some containers).
  }
  // `-l` alone, because csh and tcsh only honor it when it is the only flag.
  return {command: shell || process.env.SHELL || '/bin/sh', args: ['-l']};
}

registerElement('hdd-terminal-modal', (props: TerminalModalProps) => new TerminalModal(props));

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'hdd-terminal-modal': TerminalModalProps & {key?: React.Key};
    }
  }
}

export function Terminal(props: TerminalModalProps): JSX.Element {
  return React.createElement('hdd-terminal-modal', props);
}
