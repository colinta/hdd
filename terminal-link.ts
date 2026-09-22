import {dirname} from 'path';
import {pathToFileURL} from 'url';

const OSC = '\x1b]';
const ST = '\x1b\\';

export function fileLink(absolutePath: string, title: string): string {
  const href = pathToFileURL(absolutePath).href;
  return `${OSC}8;;${href}${ST}${title}${OSC}8;;${ST}`;
}

export function containingFolderLink(absolutePath: string, title: string): string {
  return fileLink(dirname(absolutePath), title);
}
