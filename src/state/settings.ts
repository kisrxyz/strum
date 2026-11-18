// Settings the browser remembers between launches (localStorage).
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { EngineBuffer } from '../audio/native/protocol';
import type { ChannelMode } from '../dsp/channel';
import { cleanTrim } from '../dsp/inputTrim';
import type { MainsHz } from '../dsp/mains';
import { isLang, type Lang } from '../i18n/lang';
import type { SongView } from '../song/types';
import { DEFAULT_PRESETS, forgetAssetIn, mergePreset, nextIndex, upgradeFirstAmps, upgradeFirstEffects, type Preset, type PresetPatch } from './presets';

export type LatencyMode = 'fast' | 'safe';
export type MainsSetting = 'auto' | MainsHz;
/** «Звук гитары»: the native engine (ASIO, outside the browser) or the browser's own chain. */
export type GuitarEngine = 'native' | 'browser';
/** ASIO buffer sizes the native engine takes, in frames. */
export const NATIVE_BUFFERS: readonly EngineBuffer[] = [32, 64, 128, 256];
/** What the neck shows: one fingering of the current chord, all its notes, or the whole scale. */
export type NeckView = 'shape' | 'chord' | 'scale';
export const NECK_VIEWS: readonly NeckView[] = ['shape', 'chord', 'scale'];
/** Whether the neck is shown, per song view (F): hidden under the chords and the lyrics. */
export type NeckShown = Record<SongView, boolean>;
const NECK_SHOWN: NeckShown = { chords: false, lyrics: false, tab: true, notes: true };

export interface SettingsData {
  guitarEngine: GuitarEngine;
  /** The native engine's audio device by name; null: the first real card (kv_guitar/core.py `pick_device`). */
  nativeDevice: string | null;
  nativeBuffer: EngineBuffer;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  channelMode: ChannelMode;
  latencyMode: LatencyMode;
  /** Tuner reference, Hz (430–450). */
  a4: number;
  /** The "Вход" screen was confirmed at least once. */
  setupDone: boolean;
  presets: Preset[];
  presetIndex: number;
  masterDb: number;
  /** Volume of the guitar alone, on top of the master (the song follows the master only), dB. */
  guitarDb: number;
  /**
   * «Подстроить под мою гитару»: the input's own gain, dB, before the hum filter, the gate and the
   * amp, so that the hardest strum reaches the level the amps were levelled for (src/dsp/inputTrim.ts).
   */
  inputTrimDb: number;
  /** Opened again on the next launch («Сразу играть»). */
  lastSongId: string | null;
  /** Volume of every song on top of its loudness normalisation, dB. */
  songVolumeDb: number;
  neckView: NeckView;
  neckShown: NeckShown;
  /** Degrees (1, ♭3, 5, ♭7) on the fretboard instead of note names. */
  degrees: boolean;
  /** «Сет-лист»: song ids in the order they are played. */
  setlist: string[];
  /** The interface's language (step 1 of Strum, 2026-11-17): English for a fresh install. */
  language: Lang;
  /** The hum filter's mains: heard by ear (`auto`) or chosen by hand. */
  mains: MainsSetting;
  /** The mains last heard (src/dsp/mains.ts); used while `mains` is `auto`. */
  mainsHz: MainsHz;
  /** «Запись» keeps the card's raw input beside the guitar (dry.flac): for checking a sound card. */
  saveRawInput: boolean;
}

interface SettingsActions {
  selectPreset(index: number): void;
  stepPreset(direction: 1 | -1): void;
  updatePreset(index: number, patch: PresetPatch): void;
  resetPreset(index: number): void;
  /** A user file was deleted: presets that used it go back to their own default model / cabinet. */
  forgetAsset(id: string): void;
  setMasterDb(db: number): void;
  setGuitarDb(db: number): void;
  setInputTrim(db: number): void;
  setInputDevice(id: string | null): void;
  setOutputDevice(id: string | null): void;
  setChannelMode(mode: ChannelMode): void;
  setLatencyMode(mode: LatencyMode): void;
  setGuitarEngine(engine: GuitarEngine): void;
  setNativeDevice(device: string | null): void;
  setNativeBuffer(buffer: EngineBuffer): void;
  setA4(hz: number): void;
  markSetupDone(): void;
  setLastSongId(id: string | null): void;
  setSongVolumeDb(db: number): void;
  stepNeckView(): void;
  toggleNeck(view: SongView): void;
  toggleDegrees(): void;
  setSetlist(ids: string[]): void;
  setLang(lang: Lang): void;
  setMains(mains: MainsSetting): void;
  setMainsHeard(hz: MainsHz): void;
  setSaveRawInput(on: boolean): void;
}

export type SettingsState = SettingsData & SettingsActions;

export const MASTER_MIN_DB = -40;
export const MASTER_MAX_DB = 6;
export const GUITAR_VOLUME_MIN_DB = -20;
export const GUITAR_VOLUME_MAX_DB = 10;
export const SONG_VOLUME_MIN_DB = -20;
export const SONG_VOLUME_MAX_DB = 10;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const freshPresets = (): Preset[] => DEFAULT_PRESETS.map((p) => structuredClone(p));

/** The guitar's output gain: the master plus the guitar's own volume. */
export const guitarOutDb = (s: Pick<SettingsData, 'masterDb' | 'guitarDb'>): number => s.masterDb + s.guitarDb;

/** The native engine is ASIO: it is the default on Windows only, everywhere else the browser plays. */
export function defaultGuitarEngine(userAgent: string | undefined): GuitarEngine {
  return userAgent?.includes('Windows') ? 'native' : 'browser';
}
const isGuitarEngine = (x: unknown): x is GuitarEngine => x === 'native' || x === 'browser';
const isNativeBuffer = (x: unknown): x is EngineBuffer => NATIVE_BUFFERS.includes(x as EngineBuffer);

const DEFAULTS: SettingsData = {
  guitarEngine: defaultGuitarEngine(typeof navigator === 'undefined' ? undefined : navigator.userAgent),
  nativeDevice: null,
  nativeBuffer: 128,
  inputDeviceId: null,
  outputDeviceId: null,
  channelMode: 'auto',
  latencyMode: 'fast',
  a4: 440,
  setupDone: false,
  presets: freshPresets(),
  presetIndex: 0,
  masterDb: 0,
  guitarDb: 0,
  inputTrimDb: 0,
  lastSongId: null,
  songVolumeDb: 0,
  neckView: 'shape',
  neckShown: NECK_SHOWN,
  degrees: false,
  setlist: [],
  language: 'en',
  mains: 'auto',
  mainsHz: 50,
  saveRawInput: false,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      selectPreset: (index) => set({ presetIndex: clamp(Math.round(index), 0, get().presets.length - 1) }),
      stepPreset: (direction) => set({ presetIndex: nextIndex(get().presetIndex, direction, get().presets.length) }),
      updatePreset: (index, patch) =>
        set({ presets: get().presets.map((p, i) => (i === index ? mergePreset(p, patch) : p)) }),
      resetPreset: (index) =>
        set({ presets: get().presets.map((p, i) => (i === index ? structuredClone(DEFAULT_PRESETS[i]) : p)) }),
      forgetAsset: (id) => set({ presets: get().presets.map((p, i) => forgetAssetIn(p, id, DEFAULT_PRESETS[i])) }),
      setMasterDb: (db) => set({ masterDb: clamp(db, MASTER_MIN_DB, MASTER_MAX_DB) }),
      setGuitarDb: (db) => set({ guitarDb: clamp(db, GUITAR_VOLUME_MIN_DB, GUITAR_VOLUME_MAX_DB) }),
      setInputTrim: (db) => set({ inputTrimDb: cleanTrim(db) }),
      setInputDevice: (id) => set({ inputDeviceId: id }),
      setOutputDevice: (id) => set({ outputDeviceId: id }),
      setChannelMode: (mode) => set({ channelMode: mode }),
      setLatencyMode: (mode) => set({ latencyMode: mode }),
      setGuitarEngine: (engine) => set({ guitarEngine: engine }),
      setNativeDevice: (device) => set({ nativeDevice: device }),
      setNativeBuffer: (buffer) => {
        if (isNativeBuffer(buffer)) set({ nativeBuffer: buffer });
      },
      setA4: (hz) => set({ a4: clamp(Math.round(hz), 430, 450) }),
      markSetupDone: () => set({ setupDone: true }),
      setLastSongId: (id) => set({ lastSongId: id }),
      setSongVolumeDb: (db) => set({ songVolumeDb: clamp(db, SONG_VOLUME_MIN_DB, SONG_VOLUME_MAX_DB) }),
      stepNeckView: () => set({ neckView: NECK_VIEWS[(NECK_VIEWS.indexOf(get().neckView) + 1) % NECK_VIEWS.length] }),
      toggleNeck: (view) => set({ neckShown: { ...get().neckShown, [view]: !get().neckShown[view] } }),
      toggleDegrees: () => set({ degrees: !get().degrees }),
      setSetlist: (ids) => set({ setlist: ids }),
      setLang: (language) => set({ language }),
      setMains: (mains) => set({ mains }),
      setMainsHeard: (mainsHz) => set({ mainsHz }),
      setSaveRawInput: (saveRawInput) => set({ saveRawInput }),
    }),
    {
      name: 'kvartirnik-settings',
      // 2: the presets' amps became captures of real amps; 3: their effects got drier (2026-11-16);
      // 4: languages, the mains, the raw input track (2026-11-17) — whoever had settings before is the
      // author, who reads Russian and checks his card from the raw input of his takes.
      version: 4,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        let saved = (persisted ?? {}) as Partial<SettingsData>;
        if (version < 4) saved = { ...saved, language: 'ru', saveRawInput: true };
        if (!Array.isArray(saved.presets)) return saved;
        let presets = saved.presets;
        if (version < 2) presets = upgradeFirstAmps(presets);
        if (version < 3) presets = upgradeFirstEffects(presets);
        return { ...saved, presets };
      },
      partialize: (s): SettingsData => ({
        guitarEngine: s.guitarEngine,
        nativeDevice: s.nativeDevice,
        nativeBuffer: s.nativeBuffer,
        inputDeviceId: s.inputDeviceId,
        outputDeviceId: s.outputDeviceId,
        channelMode: s.channelMode,
        latencyMode: s.latencyMode,
        a4: s.a4,
        setupDone: s.setupDone,
        presets: s.presets,
        presetIndex: s.presetIndex,
        masterDb: s.masterDb,
        guitarDb: s.guitarDb,
        inputTrimDb: s.inputTrimDb,
        lastSongId: s.lastSongId,
        songVolumeDb: s.songVolumeDb,
        neckView: s.neckView,
        neckShown: s.neckShown,
        degrees: s.degrees,
        setlist: s.setlist,
        language: s.language,
        mains: s.mains,
        mainsHz: s.mainsHz,
        saveRawInput: s.saveRawInput,
      }),
      // Fill fields added in newer versions from the defaults, preset by preset.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsData>;
        const presets = DEFAULT_PRESETS.map((def, i) => {
          const old = saved.presets?.[i];
          return old && old.id === def.id ? mergePreset(structuredClone(def), old) : structuredClone(def);
        });
        return {
          ...current,
          ...saved,
          presets,
          presetIndex: clamp(saved.presetIndex ?? 0, 0, presets.length - 1),
          // A value this version does not know falls back to the default.
          guitarEngine: isGuitarEngine(saved.guitarEngine) ? saved.guitarEngine : current.guitarEngine,
          nativeDevice: typeof saved.nativeDevice === 'string' ? saved.nativeDevice : null,
          nativeBuffer: isNativeBuffer(saved.nativeBuffer) ? saved.nativeBuffer : current.nativeBuffer,
          inputTrimDb: typeof saved.inputTrimDb === 'number' ? cleanTrim(saved.inputTrimDb) : current.inputTrimDb,
          neckView: NECK_VIEWS.includes(saved.neckView as NeckView) ? (saved.neckView as NeckView) : current.neckView,
          neckShown: { ...current.neckShown, ...saved.neckShown },
          language: isLang(saved.language) ? saved.language : current.language,
          mains: saved.mains === 50 || saved.mains === 60 || saved.mains === 'auto' ? saved.mains : current.mains,
          mainsHz: saved.mainsHz === 50 || saved.mainsHz === 60 ? saved.mainsHz : current.mainsHz,
          saveRawInput: typeof saved.saveRawInput === 'boolean' ? saved.saveRawInput : current.saveRawInput,
        };
      },
    },
  ),
);

export const currentPreset = (s: SettingsState): Preset => s.presets[s.presetIndex];
