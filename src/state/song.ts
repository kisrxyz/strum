// The open song (not remembered by the browser: the service keeps it in song.json).
// The player's own position lives in the player; this store holds what the screen shows.
import { L } from '../i18n';
import { create } from 'zustand';
import { api, type SongPatch } from '../song/api';
import type { Analysis, Lyrics, ModelId, PlayerSettings, Song, TabInfo, Transcript } from '../song/types';
import { useRuntime } from './runtime';

export type { SongPatch };
export type SongLoad = 'idle' | 'loading' | 'ready' | 'error';

/** Collects changes and sends them as one patch `delayMs` after the last one. */
export function createSaver<T>(
  send: (patch: T) => Promise<unknown>,
  delayMs: number,
  merge: (a: T, b: T) => T,
): { push(patch: T): void; flush(): Promise<void>; pending(): T | null } {
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const patch = pending;
    pending = null;
    if (patch !== null) await send(patch);
  };
  return {
    push(patch) {
      pending = pending === null ? patch : merge(pending, patch);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush().catch(() => undefined), delayMs);
    },
    flush,
    pending: () => pending,
  };
}

export function mergeSongPatch(a: SongPatch, b: SongPatch): SongPatch {
  const merged: SongPatch = { ...a, ...b };
  if (a.tab || b.tab) merged.tab = { ...a.tab, ...b.tab };
  if (a.player || b.player) {
    merged.player = { ...a.player, ...b.player };
    if (a.player?.volumesDb || b.player?.volumesDb) {
      merged.player.volumesDb = { ...a.player?.volumesDb, ...b.player?.volumesDb } as PlayerSettings['volumesDb'];
    }
  }
  return merged;
}

const SAVE_DELAY_MS = 500;

const STAGE2_PLAYER: Pick<
  PlayerSettings,
  'capo' | 'tuning' | 'simpleChords' | 'mode' | 'reveal' | 'countIn' | 'click' | 'toneMatch' | 'tuningApplied' | 'view'
> = {
  capo: 0,
  tuning: 'standard',
  simpleChords: false,
  mode: 'play',
  reveal: 0,
  countIn: false,
  click: false,
  toneMatch: true,
  tuningApplied: false,
  view: 'chords',
};

/** A song from an older service (stage 1 or 2) gets the newer fields with their defaults. */
export function withDefaults(song: Song): Song {
  return {
    ...song,
    kind: song.kind ?? 'recording',
    analysis: song.analysis ?? null,
    chords: song.chords ?? null,
    barShift: song.barShift ?? 0,
    transcript: song.transcript ?? null,
    lyrics: song.lyrics ?? null,
    tab: song.tab ?? null,
    guitarNotes: song.guitarNotes ?? null,
    lists: song.lists ?? [],
    player: { ...STAGE2_PLAYER, ...song.player },
  };
}

function saverFor(id: string) {
  return createSaver<SongPatch>(
    async (patch) => {
      try {
        await api.patchSong(id, patch);
      } catch (error) {
        useRuntime.getState().showToast(
          L().actions.song.settingsNotSaved(error instanceof Error ? error.message : ''),
          'warn',
        );
      }
    },
    SAVE_DELAY_MS,
    mergeSongPatch,
  );
}

let saver: ReturnType<typeof saverFor> | null = null;

/** What belongs to the open song only and starts empty with another one. */
const EMPTY_EXTRAS = {
  analysis: null,
  editIndex: null,
  voicing: 0,
  words: null,
  editingLyrics: false,
  mixerOpen: false,
  peaks: null,
  parts: [] as string[],
} as const;

interface SongData {
  song: Song | null;
  /** Loading of the audio into the player (bindings.ts drives it). */
  state: SongLoad;
  /** What the player has loaded: the whole mix while separating, a model's stems, or a tab-song's own render. */
  source: 'mix' | ModelId | 'tab' | null;
  playing: boolean;
  message: string | null;
  /** The service's analysis (beats, chords, key…) of the open song, once it is ready. */
  analysis: Analysis | null;
  /** The chord segment being corrected (index into the chord track), or null. */
  editIndex: number | null;
  /** Which of the current chord's fingerings is chosen (V). */
  voicing: number;
  /** The words heard in the vocal stem (words.json), once they are ready. */
  words: Transcript | null;
  /** The lyrics editor is open (it takes the place of the fretboard). */
  editingLyrics: boolean;
  /** The stems' mixer is open (it takes the place of the fretboard). */
  mixerOpen: boolean;
  /** A tab-song's waveform (a recording's comes from the service). */
  peaks: Int8Array | null;
  /** A tab-song's parts, known once it is rendered (a recording's tab reports them when shown). */
  parts: string[];
}

interface SongActions {
  openSong(id: string): Promise<void>;
  closeSong(): Promise<void>;
  /** Changes the player settings at once and saves them half a second later. */
  updatePlayer(patch: Partial<PlayerSettings>): void;
  /** Title, artist, notes, the active model, lyrics, tab settings: same saving as the player settings. */
  updateSong(patch: Omit<SongPatch, 'player'>): void;
  /** The lyrics (null: none). */
  updateLyrics(lyrics: Lyrics | null): void;
  /** The tab's part and bar sync. */
  updateTab(patch: Partial<Pick<TabInfo, 'track' | 'notation' | 'offset' | 'ratio'>>): void;
  /** A newer copy from the service: stems status and the like; local unsaved edits win. */
  syncFromLibrary(song: Song): void;
  patch(p: Partial<SongData>): void;
}

export const useSong = create<SongData & SongActions>()((set, get) => ({
  song: null,
  state: 'idle',
  source: null,
  playing: false,
  message: null,
  analysis: null,
  editIndex: null,
  voicing: 0,
  words: null,
  editingLyrics: false,
  mixerOpen: false,
  peaks: null,
  parts: [],
  async openSong(id) {
    if (get().song?.id === id && get().state !== 'error') {
      // Already open: only refresh it. Resetting the state would wait for a load that never comes.
      get().syncFromLibrary(await api.getSong(id));
      return;
    }
    await saver?.flush();
    const song = withDefaults(await api.getSong(id));
    saver = saverFor(id);
    set({ song, state: 'loading', source: null, playing: false, message: null, ...EMPTY_EXTRAS });
  },
  async closeSong() {
    await saver?.flush();
    saver = null;
    set({ song: null, state: 'idle', source: null, playing: false, message: null, ...EMPTY_EXTRAS });
  },
  updatePlayer(patch) {
    const song = get().song;
    if (!song) return;
    const player = { ...song.player, ...patch };
    if (patch.volumesDb) player.volumesDb = { ...song.player.volumesDb, ...patch.volumesDb };
    set({ song: { ...song, player } });
    saver?.push({ player: patch });
  },
  updateSong(patch) {
    const song = get().song;
    if (!song) return;
    const { tab, ...rest } = patch;
    set({ song: { ...song, ...rest, ...(tab ? { tab: song.tab ? { ...song.tab, ...tab } : null } : {}) } });
    if (tab && !song.tab) return; // nothing to change on a song without a tab
    saver?.push(patch);
  },
  updateLyrics(lyrics) {
    get().updateSong({ lyrics });
  },
  updateTab(patch) {
    get().updateSong({ tab: patch });
  },
  syncFromLibrary(fresh) {
    const song = get().song;
    if (!song || fresh.id !== song.id) return;
    const { player: _unsavedPlayer, ...unsavedTop } = saver?.pending() ?? {};
    // The chord edits, the bar shift, the lyrics and the tab sync are changed only here, never by
    // the service: the local copy wins, also while a save is on its way (a poll answered before it
    // would undo the edit). The tab file itself is replaced through putTab, which sets the song.
    const tab = song.tab && fresh.tab && fresh.tab.addedAt === song.tab.addedAt ? song.tab : (fresh.tab ?? null);
    set({
      song: {
        ...withDefaults(fresh),
        ...unsavedTop,
        player: song.player,
        chords: song.chords,
        barShift: song.barShift,
        lyrics: song.lyrics,
        guitarNotes: song.guitarNotes,
        lists: song.lists,
        tab,
      },
    });
  },
  patch: (p) => set(p),
}));
