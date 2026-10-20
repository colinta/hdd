import {describe, expect, it} from 'vitest';
import {tildify} from '../paths.js';

describe('tildify', () => {
  it('abbreviates the home directory', () => {
    expect(tildify('/Users/me', '/Users/me')).toBe('~');
    expect(tildify('/Users/me/world/trees', '/Users/me')).toBe('~/world/trees');
    expect(tildify('/Users/me/src', '/Users/me/')).toBe('~/src');
  });

  it('leaves other paths alone', () => {
    expect(tildify('/Users/meme/src', '/Users/me')).toBe('/Users/meme/src');
    expect(tildify('/tmp', '/Users/me')).toBe('/tmp');
    expect(tildify('/tmp', '/')).toBe('/tmp');
  });
});
