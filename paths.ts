import {homedir} from 'node:os';
import {sep} from 'node:path';

/** Abbreviates the home directory as `~`, like a shell prompt. */
export function tildify(path: string, home = homedir()): string {
  if (!home || home === sep) {
    return path;
  }
  const trimmedHome = home.endsWith(sep) ? home.slice(0, -1) : home;
  if (path === trimmedHome) {
    return '~';
  }
  return path.startsWith(trimmedHome + sep) ? '~' + path.slice(trimmedHome.length) : path;
}
