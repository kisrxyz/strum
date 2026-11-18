// Chords: the song service's labels (BTC notation) ↔ root and quality, chord tones, names.
import type { ChordLabel } from '../song/types';

export type Quality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'min6'
  | 'maj6'
  | 'min7'
  | 'minmaj7'
  | 'maj7'
  | '7'
  | 'dim7'
  | 'hdim7'
  | 'sus2'
  | 'sus4';

/** Every quality, in the order the chord editor offers them. */
export const QUALITIES: readonly Quality[] = ['maj', 'min', '7', 'min7', 'maj7', 'sus4', 'sus2', 'dim', 'aug', 'maj6', 'min6', 'dim7', 'hdim7', 'minmaj7'];

export interface Chord {
  /** Pitch class of the root: 0 = C … 11 = B. */
  root: number;
  quality: Quality;
}

export type Spelling = 'sharps' | 'flats';

/** Semitones above the root, root first. */
const INTERVALS: Record<Quality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  min6: [0, 3, 7, 9],
  maj6: [0, 4, 7, 9],
  min7: [0, 3, 7, 10],
  minmaj7: [0, 3, 7, 11],
  maj7: [0, 4, 7, 11],
  '7': [0, 4, 7, 10],
  dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};

const SUFFIXES: Record<Quality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  min6: 'm6',
  maj6: '6',
  min7: 'm7',
  minmaj7: 'm(maj7)',
  maj7: 'maj7',
  '7': '7',
  dim7: 'dim7',
  hdim7: 'm7♭5',
  sus2: 'sus2',
  sus4: 'sus4',
};

/** What «простые аккорды» turn into minor; everything else becomes major. */
const MINOR_LIKE: ReadonlySet<Quality> = new Set<Quality>(['min', 'min6', 'min7', 'minmaj7', 'dim', 'dim7', 'hdim7']);
const KNOWN: ReadonlySet<string> = new Set<string>(QUALITIES);

/** Roots as the service writes them: sharps, plain ASCII. */
const LABEL_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTALS: Record<string, number> = { '#': 1, '♯': 1, b: -1, '♭': -1 };
const LABEL = /^([A-G])([#♯b♭]?)(?::([a-z0-9]+))?$/;

/** A note number of any octave (or any integer) → its pitch class 0–11. */
export const pitchClass = (note: number): number => ((note % 12) + 12) % 12;

/** A label from the service (sharps) or typed by hand (flats too). Null for N, X and anything else. */
export function parseChord(label: ChordLabel): Chord | null {
  const match = LABEL.exec(label.trim());
  if (!match) return null;
  const [, letter, accidental, quality = 'maj'] = match;
  if (!KNOWN.has(quality)) return null;
  return { root: pitchClass(LETTERS[letter] + (ACCIDENTALS[accidental] ?? 0)), quality: quality as Quality };
}

/** The service's label of a chord: sharps, `maj` written as the bare root. */
export function chordLabel(chord: Chord): ChordLabel {
  const root = LABEL_ROOTS[pitchClass(chord.root)];
  return chord.quality === 'maj' ? root : `${root}:${chord.quality}`;
}

export function chordIntervals(quality: Quality): number[] {
  return [...INTERVALS[quality]];
}

/** Pitch classes of the chord, root first. */
export function chordTones(chord: Chord): number[] {
  return INTERVALS[chord.quality].map((i) => pitchClass(chord.root + i));
}

/** «Простые аккорды»: only major and minor triads (Am7 → Am, G7 → G, Bdim → Bm, Asus4 → A). */
export function simplify(chord: Chord): Chord {
  return { root: pitchClass(chord.root), quality: MINOR_LIKE.has(chord.quality) ? 'min' : 'maj' };
}

export function transposeChord(chord: Chord, semitones: number): Chord {
  return { root: pitchClass(chord.root + semitones), quality: chord.quality };
}

/** C, C♯ / D♭, …, B♭, B. */
export function noteName(pc: number, spelling: Spelling): string {
  return (spelling === 'flats' ? FLAT_NAMES : SHARP_NAMES)[pitchClass(pc)];
}

/** As in songbooks: B♭, F♯m, G7, Bm7♭5, Cm(maj7). No chord → «—». */
export function chordName(chord: Chord | null, spelling: Spelling): string {
  return chord ? noteName(chord.root, spelling) + SUFFIXES[chord.quality] : '—';
}
