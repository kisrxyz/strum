// What is happening right now (not remembered between launches).
import { create } from 'zustand';
import type { AssetInfo } from '../audio/assets';
import type { EngineState, EngineStats } from '../audio/native/protocol';
import type { LatencyEstimate } from '../dsp/latency';
import type { LibraryList, Queue } from '../song/setlist';

export type EngineStatus = 'idle' | 'starting' | 'running' | 'error';
export type EngineErrorKind = 'permission' | 'no-device' | 'busy' | 'unsupported' | 'other';
export type AmpState = 'idle' | 'loading' | 'ready' | 'fallback';
/** Screens: «Песня» (main), «Песни», «Комбик», «Вход». */
export type View = 'song' | 'library' | 'amp' | 'input';

/** Who plays the guitar now: the native engine (ASIO) or the browser's own chain. */
export type GuitarPath = 'native' | 'browser';

/**
 * The connection to the native engine: 'off' (not wanted, or the browser mode), 'connecting'
 * (reaching it, or waiting for the card), 'ready' (the engine runs: the native path), 'lost'
 * (unreachable or not running; the browser path plays, or is about to).
 */
export type NativeLinkStatus = 'off' | 'connecting' | 'ready' | 'lost';

export interface NativeRuntime {
  link: NativeLinkStatus;
  /** The engine's latest `state` (kept when the link is lost, for its device list). */
  state: EngineState | null;
  /** The engine's latest `stats` (10 Hz). */
  stats: EngineStats | null;
  /** Why the browser plays when the native engine was chosen; null otherwise. Kept as what happened,
   *  not as words, so it shows in the language of the moment (`nativeNoteText`). */
  note: NativeNote | null;
}

/** Why the guitar is not on ASIO: it did not start, it was lost, or the engine said why. */
export type NativeNote = { kind: 'notStarted' } | { kind: 'lost' } | { kind: 'text'; text: string };

export interface DeviceOption {
  id: string;
  label: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'warn';
}

interface RuntimeData {
  status: EngineStatus;
  /** The path the guitar takes now (null until started). */
  guitarPath: GuitarPath | null;
  native: NativeRuntime;
  error: { kind: EngineErrorKind; detail?: string } | null;
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  canPickOutput: boolean;
  activeInputLabel: string | null;
  inputLost: boolean;
  sampleRate: number | null;
  latency: LatencyEstimate | null;
  amp: { state: AmpState; message?: string };
  userAssets: AssetInfo[];
  muted: boolean;
  view: View;
  bigTuner: boolean;
  toast: Toast | null;
  /** «Звук как в песне»: EQ change the open song asks for, on top of the preset (dB). */
  toneOffsets: { bass: number; mid: number; treble: number } | null;
  /** «Сцена» (`): the whole screen, big chords and lyrics or the tab. */
  stage: boolean;
  /** The parts of the open song's tab (filled when the tab panel has read the file). */
  tabTracks: string[];
  /** How the open tab is tied to the recording now (the automatic guess or the user's). */
  tabSync: { offset: number; ratio: 0.5 | 1 | 2 } | null;
  /** The tab's notes at the cursor and the next ones, for the fretboard (null: no tab running). */
  tabNotes: { now: { string: number; fret: number }[]; next: { string: number; fret: number }[] } | null;
  // ---- stage 4
  /** «Повтори за мной» (Shift+R): loop passes with and without the original guitar, in turns. */
  repeat: boolean;
  /** «Разгон» (Shift+=): the loop gets 5 % faster each pass, up to 100 %. */
  speedTrainer: boolean;
  /** The set-list or the radio being played (null: songs one by one). */
  queue: Queue | null;
  /** The list shown on «Песни» and the search there. */
  libraryList: LibraryList;
  search: string;
  /** The note of the «Ноты» lane being edited (index into the effective notes), null: none. */
  noteEdit: number | null;
  /** «Настройки» of the song open in the neck's place (the mixer is `useSong.mixerOpen`). */
  songSettings: boolean;
  /** «Подстроить под мою гитару» listens for hard strums (on «Вход»). */
  trimListening: boolean;
  /** The Keys sheet (F1 or ?), over any screen. */
  keysOpen: boolean;
  /** About Strum: the version and every license (a link on «Вход»). */
  aboutOpen: boolean;
}

interface RuntimeActions {
  patch(p: Partial<RuntimeData>): void;
  showToast(text: string, tone?: Toast['tone']): void;
}

export const useRuntime = create<RuntimeData & RuntimeActions>()((set) => ({
  status: 'idle',
  guitarPath: null,
  native: { link: 'off', state: null, stats: null, note: null },
  error: null,
  inputs: [],
  outputs: [],
  canPickOutput: false,
  activeInputLabel: null,
  inputLost: false,
  sampleRate: null,
  latency: null,
  amp: { state: 'idle' },
  userAssets: [],
  muted: false,
  view: 'song',
  bigTuner: false,
  toast: null,
  toneOffsets: null,
  stage: false,
  tabTracks: [],
  tabSync: null,
  tabNotes: null,
  repeat: false,
  speedTrainer: false,
  queue: null,
  libraryList: 'all',
  search: '',
  noteEdit: null,
  songSettings: false,
  trimListening: false,
  keysOpen: false,
  aboutOpen: false,
  patch: (p) => set(p),
  showToast: (text, tone = 'info') => set({ toast: { id: Date.now() + Math.random(), text, tone } }),
}));
