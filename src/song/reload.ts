// When the open song must be loaded into the player again.
import type { SongLoad } from '../state/song';

export interface ReloadCheck {
  /** What should be playing: `<song id>:mix` or `<song id>:<model>@<finishedAt>`. */
  wanted: string;
  loaded: string | null;
  /** The last key that failed to load. */
  failed: string | null;
  state: SongLoad;
  prevState: SongLoad;
}

export function needsReload({ wanted, loaded, failed, state, prevState }: ReloadCheck): boolean {
  if (wanted === loaded) return false;
  if (prevState === 'error' && state === 'loading') return true; // the user opened the song again
  // A failed load is not retried on every library refresh, only when something new is there.
  return state !== 'loading' && wanted !== failed;
}
