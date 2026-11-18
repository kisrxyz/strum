import type { Lang } from '../i18n/lang';
import type { ServiceMessage } from '../i18n/messages';
// Mirrors of the song service's data: song.json and /api/health (service/src/kv_service).

export const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const;
export type Stem = (typeof STEMS)[number];


export const MODELS = ['htdemucs_6s', 'bs_roformer_sw'] as const;
export type ModelId = (typeof MODELS)[number];

export const MODEL_NAMES: Record<ModelId, string> = {
  htdemucs_6s: 'Demucs 6s',
  bs_roformer_sw: 'BS-RoFormer SW',
};

export type StemStatus = 'queued' | 'running' | 'ready' | 'error';

export interface StemsInfo {
  status: StemStatus;
  /** 0..1 while running. */
  progress?: number;
  seconds?: number;
  loadSeconds?: number;
  device?: string;
  peakVramMb?: number | null;
  /** Common headroom gain the stems were stored with (≤ 0). */
  gainDb?: number;
  /** What the service had to do (e.g. it fell back to the CPU): a message code, or an old text. */
  note?: string | ServiceMessage | null;
  error?: string | ServiceMessage | null;
  /** Changes whenever the stems are made again: part of their URLs. */
  finishedAt?: string;
}

export interface Loop {
  start: number;
  /** `end <= start` means only the start (A) is set. */
  end: number;
  on: boolean;
}

export interface Bookmark {
  name: string;
  start: number;
  end: number;
}

export type TuningId = 'standard' | 'eb' | 'dropd';
export type SongMode = 'play' | 'ear';
/** «Снять на слух» hints: 0 nothing, 1 change moments, 2 the current chord, 3 everything. */
export type RevealLevel = 0 | 1 | 2 | 3;

export interface PlayerSettings {
  /** Playback rate, 0.5–1. */
  speed: number;
  semitones: number;
  cents: number;
  volumesDb: Record<Stem, number>;
  muted: Stem[];
  solo: Stem | null;
  loop: Loop;
  bookmarks: Bookmark[];
  /** Preset of the amp the song was last played with. */
  presetId: string | null;
  // ---- stage 2
  /** Capo fret, 0–9 (0 = no capo). Chord names and shapes are shown relative to it. */
  capo: number;
  /** The guitar's tuning for this song (tuner, fretboard, shapes). */
  tuning: TuningId;
  /** Show only major / minor triads (no sevenths, sus, added notes). */
  simpleChords: boolean;
  /** «Играть» (everything visible) or «Снять на слух» (hidden, opened step by step). */
  mode: SongMode;
  reveal: RevealLevel;
  /** A bar of clicks before playback starts. */
  countIn: boolean;
  /** Clicks on the song's own beats while it plays. */
  click: boolean;
  /** «Звук как в песне»: the amp follows the guitar heard in the recording. */
  toneMatch: boolean;
  /** The recording's drift from 440 Hz was already turned into `cents` once. */
  tuningApplied: boolean;
  // ---- stage 3
  /** What runs under the wave: the chord lane, the lyrics or the tab (W). */
  view: SongView;
}

export type SongView = 'chords' | 'lyrics' | 'tab' | 'notes';

/** A note heard in the guitar stem («радар нот»), or the user's edited one. */
export interface GuitarNote {
  /** Seconds. */
  start: number;
  end: number;
  /** MIDI note number (E2 = 40 … E6 = 88). */
  midi: number;
  /** How clearly it was heard, 0..1 (the analysis' notes only). */
  conf?: number;
}

/** The lists a song can be in (the set-list order is kept in the browser's settings). */
export type SongList = 'favorite' | 'learn';

/** The words heard in the vocal stem (the service's words.json). */
export interface Transcript {
  version: number;
  model: string;
  source: ModelId;
  /** Whisper's guess, e.g. 'ru', 'kk'; '' for an instrumental. */
  language: string;
  words: { start: number; end: number; word: string; p: number }[];
  /** Whisper's own lines: the draft lyrics. */
  lines: { start: number; end: number; text: string }[];
}

/** Transcription job state, kept in song.json (like the analysis). */
export interface TranscriptInfo {
  status: StemStatus;
  /** 0..1 while running. */
  progress?: number;
  version?: number;
  source?: ModelId;
  language?: string;
  seconds?: number;
  device?: string;
  /** A message code (src/i18n/messages.ts), or the raw text of an unexpected failure. */
  error?: string | ServiceMessage | null;
  finishedAt?: string;
}

/** The user's lyrics: the text as pasted or imported; the app works out its timing. */
export interface Lyrics {
  source: 'paste' | 'file' | 'lrclib' | 'draft';
  text: string;
  /** «;»: this line starts at this time. */
  anchors: { line: number; time: number }[];
  /** Semitones the text's chords are moved to match the recording; null = found automatically. */
  shift: number | null;
}

/** The song's tab file and how it is tied to the recording. */
export interface TabInfo {
  name: string;
  ext: string;
  size: number;
  addedAt: string;
  /** The part shown ('): index into the score's tracks. */
  track: number;
  /** Standard notation above the tab (Shift+'). */
  notation: boolean;
  /** The recording bar the tab's first bar starts on; null = found automatically. */
  offset: number | null;
  /** Recording bars per tab bar; null = from the tempos. */
  ratio: 0.5 | 1 | 2 | null;
}

/**
 * A chord label as the song service stores it (BTC's notation): 'N' (no chord), 'X' (unknown),
 * a root with sharps ('C', 'F#') for major, or root:quality ('A:min', 'G:7', 'B:hdim7').
 * Qualities: min maj dim aug min6 maj6 min7 minmaj7 maj7 7 dim7 hdim7 sus2 sus4.
 */
export type ChordLabel = string;

export interface ChordSegment {
  /** Seconds. */
  start: number;
  end: number;
  chord: ChordLabel;
}

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'bridge' | 'solo' | 'outro' | 'other';

export interface Section {
  start: number;
  end: number;
  kind: SectionKind;
  /** Russian, numbered: «Вступление», «Куплет 1», «Припев 2», «Проигрыш», «Соло», «Концовка», «Часть 3». */
  name: string;
}

export type AmpPresetId = 'clean-chorus' | 'crunch' | 'drive' | 'solo';

export interface ToneMatch {
  presetId: AmpPresetId;
  /** EQ change on top of the preset, dB, whole numbers within −4…+4. */
  bass: number;
  mid: number;
  treble: number;
  /** 0..1: how sure the guess is. */
  confidence: number;
}

/** The service's analysis of a song: analysis.json (machine output; user edits live in song.json). */
export interface Analysis {
  version: number;
  /** The stems used for sections, tone and tuning ('mix': the song had none). Chords and beats always come from the mix.
   * 'tab': a tab-song's analysis, made by the app from the score itself. */
  source: 'mix' | ModelId | 'tab';
  /** Every beat, seconds, ascending. */
  beats: number[];
  /** The beats that start a bar (a subset of `beats`). */
  downbeats: number[];
  /** Beats per minute (median), 0 when no beats were found. */
  tempo: number;
  /** Beats per bar, 2–7 (most common), 4 when unknown. */
  meter: number;
  chords: ChordSegment[];
  /** Tonic as a pitch class (0 = C … 11 = B). Null when there are too few chords. */
  key: { tonic: number; mode: 'major' | 'minor'; confidence: number } | null;
  /** The recording's drift from A = 440 Hz, cents, −50…+50. */
  tuningCents: number;
  sections: Section[];
  /** Null without stems or when the guitar stem is (almost) silent. */
  tone: ToneMatch | null;
  /** The notes of the guitar stem (analysis v2; empty without a guitar stem, missing in v1). */
  notes?: GuitarNote[];
  /** The notes' model was not installed: no notes yet, the service analyses again once it is. */
  notesMissing?: boolean;
}

/** Analysis job state, kept in song.json (like the stems). */
export interface AnalysisInfo {
  status: StemStatus;
  /** 0..1 while running. */
  progress?: number;
  version?: number;
  source?: 'mix' | ModelId | 'tab';
  seconds?: number;
  device?: string;
  /** A message code (src/i18n/messages.ts), or the raw text of an unexpected failure. */
  error?: string | ServiceMessage | null;
  /** Changes whenever the analysis is made again: part of its URL. */
  finishedAt?: string;
  /** A summary for the song list (the same values as in analysis.json). */
  tempo?: number;
  meter?: number;
  key?: Analysis['key'];
  notesMissing?: boolean;
}

/** 'tab': a tab played by the app itself (song.json and the tab file only: no recording, no stems). */
export type SongKind = 'recording' | 'tab';

export interface Song {
  version: number;
  /** Missing in songs read before tab-songs existed: a recording. */
  kind?: SongKind;
  id: string;
  title: string;
  artist: string;
  fileName: string;
  originalExt: string;
  addedAt: string;
  /** Seconds. */
  duration: number;
  sampleRate: number;
  /** Gated average loudness of the stored mix, dB. */
  loudnessDb: number;
  mixGainDb: number;
  stems: Partial<Record<ModelId, StemsInfo>>;
  activeModel: ModelId | null;
  notes: string;
  player: PlayerSettings;
  // ---- stage 2
  analysis: AnalysisInfo | null;
  /** The user's corrected chords; null = use the analysis' chords as they are. */
  chords: ChordSegment[] | null;
  /** Moves the bar lines by whole beats when the analysis got the first beat of the bar wrong. */
  barShift: number;
  // ---- stage 3
  transcript: TranscriptInfo | null;
  lyrics: Lyrics | null;
  tab: TabInfo | null;
  // ---- stage 4
  /** The user's edited notes of the guitar; null = the analysis' own. (`notes` is the text of the song card.) */
  guitarNotes: GuitarNote[] | null;
  lists: SongList[];
}

export const isTabSong = (song: Pick<Song, 'kind'> | null | undefined): boolean => song?.kind === 'tab';

export interface Health {
  ok: boolean;
  mlInstalled: boolean;
  models: { id: ModelId; name: string; ready: boolean }[];
  defaultModel: ModelId;
  maxSeconds: number;
  device: 'cuda' | 'mps' | 'cpu';
  gpuName: string | null;
  /** Beat This! and BTC: whether their weights are downloaded. */
  analysisModels: { id: 'beat_this' | 'btc'; name: string; ready: boolean }[];
  /** Whisper: whether its weights are downloaded. */
  lyricsModel?: { id: 'whisper'; name: string; ready: boolean };
  /** The installed app downloads its neural networks itself (service components.py). */
  components?: ComponentsStatus;
}

export interface ComponentPart {
  state: 'missing' | 'installing' | 'ready' | 'failed';
  stage: '' | 'packages' | 'weights' | 'restarting';
  done: number;
  total: number;
  unit: 'bytes' | 'steps';
  error: ServiceMessage | null;
  flavor: '' | 'cuda' | 'cpu';
  /** Before the download: about how many bytes «Download» will take. */
  estimate?: number;
}

export interface ComponentsStatus {
  /** Only the installed app downloads; the author's copy has everything from `npm run setup`. */
  canInstall: boolean;
  /** Separation and analysis: PyTorch, Demucs, Beat This!, BTC. */
  songs: ComponentPart;
  /** Whisper, on request. */
  words: ComponentPart;
}

export interface ExportBody {
  model: ModelId;
  gains: Record<Stem, number>;
  speed: number;
  semitones: number;
  start: number;
  end: number | null;
  /** The interface's language: it names the mp3 the service builds. */
  lang?: Lang;
}

/** «Запись»: one take of the user's playing (service: takes.py, `take.json`). */
export interface Take {
  id: string;
  /** The song's title, or «Без песни». */
  title: string;
  artist: string;
  songId: string | null;
  /** ISO time, UTC. */
  createdAt: string;
  /** `recording`: chunks still arrive; `saving`: the files are being built. */
  status: 'recording' | 'saving' | 'ready' | 'error';
  error: string | ServiceMessage | null;
  /** Seconds. */
  duration: number;
  sampleRate: number | null;
  /** A song played during the take (it is in the mp3 too). */
  hasBand: boolean;
  /** «Гитара раньше / позже», ms (positive: later). */
  guitarOffsetMs: number;
  path: 'native' | 'browser';
}
