import { describe, expect, it } from 'vitest';
import { needsReload } from './reload';

describe('needsReload', () => {
  it('loads when the wanted audio changed, e.g. the stems became ready', () => {
    expect(needsReload({ wanted: 'a:m@1', loaded: 'a:mix', failed: null, state: 'ready', prevState: 'ready' })).toBe(true);
  });

  it('does nothing when that audio is already loaded or loading', () => {
    expect(needsReload({ wanted: 'a:mix', loaded: 'a:mix', failed: null, state: 'ready', prevState: 'ready' })).toBe(false);
    expect(needsReload({ wanted: 'a:m@1', loaded: 'a:mix', failed: null, state: 'loading', prevState: 'loading' })).toBe(false);
  });

  it('does not retry the same failure on every refresh of the library', () => {
    expect(needsReload({ wanted: 'a:mix', loaded: null, failed: 'a:mix', state: 'error', prevState: 'error' })).toBe(false);
  });

  it('tries again when something new is there or the song is opened again', () => {
    expect(needsReload({ wanted: 'a:m@2', loaded: null, failed: 'a:m@1', state: 'error', prevState: 'error' })).toBe(true);
    expect(needsReload({ wanted: 'a:mix', loaded: null, failed: 'a:mix', state: 'loading', prevState: 'error' })).toBe(true);
  });
});
