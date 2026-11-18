// Chords as people write them in songbooks and on amdm.ru / Ultimate Guitar: «Am», «H7», «F#m7»,
// «Bb», «C(add9)», «Am/G», «E5». Read into our chord model (the nearest of the 14 qualities).
import { pitchClass, type Chord, type Quality } from './chords';

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };
const ACCIDENTALS: Record<string, number> = { '#': 1, '♯': 1, b: -1, '♭': -1 };
const TOKEN = /^([A-H])([#♯b♭]?)([^/]*)(?:\/([A-H])([#♯b♭]?))?$/;

/** Exact suffixes (after dropping brackets and spaces). Case matters: «M7» is maj7, «m7» is min7. */
const SUFFIXES: Record<string, Quality> = {
  '': 'maj',
  maj: 'maj',
  M: 'maj',
  add9: 'maj',
  add2: 'maj',
  add11: 'maj',
  '2': 'maj',
  '5': 'maj',
  m: 'min',
  mi: 'min',
  min: 'min',
  '-': 'min',
  madd9: 'min',
  '7': '7',
  '9': '7',
  '11': '7',
  '13': '7',
  '7b9': '7',
  '7#9': '7',
  '7♭9': '7',
  '7♯9': '7',
  '7#5': 'aug',
  '7+': 'aug',
  m7: 'min7',
  mi7: 'min7',
  min7: 'min7',
  '-7': 'min7',
  m9: 'min7',
  m11: 'min7',
  maj7: 'maj7',
  ma7: 'maj7',
  M7: 'maj7',
  'Δ': 'maj7',
  'Δ7': 'maj7',
  maj9: 'maj7',
  dim: 'dim',
  '°': 'dim',
  dim7: 'dim7',
  '°7': 'dim7',
  m7b5: 'hdim7',
  'm7♭5': 'hdim7',
  'm7-5': 'hdim7',
  'ø': 'hdim7',
  'ø7': 'hdim7',
  aug: 'aug',
  '+': 'aug',
  '+5': 'aug',
  '#5': 'aug',
  sus: 'sus4',
  sus4: 'sus4',
  '7sus4': 'sus4',
  sus2: 'sus2',
  '6': 'maj6',
  maj6: 'maj6',
  m6: 'min6',
  min6: 'min6',
  mmaj7: 'minmaj7',
  mM7: 'minmaj7',
  'm(maj7)': 'minmaj7',
  minmaj7: 'minmaj7',
};

/**
 * A chord written in text, or null when the token is not one (a word, «x2», a Cyrillic «А»).
 * `germanB`: the text writes H for B, so its B is B♭ (Russian and German songbooks).
 */
export function parseChordText(token: string, germanB = false): { chord: Chord; bass: number | null } | null {
  const bare = token.trim().replace(/^\((.*)\)$/, '$1');
  const match = TOKEN.exec(bare);
  if (!match) return null;
  const [, letter, accidental, rawSuffix, bassLetter, bassAccidental] = match;
  // «m(maj7)» keeps its brackets; «C(add9)» and «Am(9)» lose them.
  const suffix = rawSuffix.replace(/\s+/g, '');
  const quality = SUFFIXES[suffix] ?? SUFFIXES[suffix.replace(/[()]/g, '')];
  if (!quality) return null;
  // Under H for B, B is B♭ already, written with its flat or without.
  const pitch = (l: string, acc: string) =>
    germanB && l === 'B' && (acc === '' || ACCIDENTALS[acc] === -1) ? 10 : ROOTS[l] + (ACCIDENTALS[acc] ?? 0);
  const root = pitchClass(pitch(letter, accidental));
  const bass = bassLetter ? pitchClass(pitch(bassLetter, bassAccidental)) : null;
  return { chord: { root, quality }, bass };
}

/** Repeat marks: «x2», «2x», «(х3)», «(2 раза)». */
const REPEATS = /\(?\s*(?:[xхXХ×]\s*\d+|\d+\s*[xхXХ×]|\d+\s*раз[а]?)\s*\)?/gu;
/** Bar lines and dashes that may stand between chords in a chord line. */
const FILLER = /^(\|+|:?\|\|?:?|-+|\.{2,})$/u;

/** True when the line holds chords only (with bar lines and «x2» marks between them). */
export function isChordLine(line: string): boolean {
  const tokens = line.replace(REPEATS, ' ').trim().split(/\s+/).filter(Boolean);
  let chords = 0;
  for (const token of tokens) {
    if (parseChordText(token)) chords++;
    else if (!FILLER.test(token)) return false;
  }
  return chords > 0;
}

/** Where each chord of a chord line starts (its column) and how it is written. */
export function chordColumns(line: string, germanB = false): { at: number; text: string; chord: Chord }[] {
  const out: { at: number; text: string; chord: Chord }[] = [];
  for (const match of line.matchAll(/\S+/g)) {
    const parsed = parseChordText(match[0], germanB);
    if (parsed) out.push({ at: match.index ?? 0, text: match[0], chord: parsed.chord });
  }
  return out;
}

/**
 * True when the chord lines write H for B: then their B is B♭. An H chord among other chords, or H
 * chords on two lines, is enough; a lone «Hm» on one line may be humming in a lyric.
 */
export function usesGermanB(lines: readonly string[]): boolean {
  let lone = 0;
  for (const line of lines) {
    if (!isChordLine(line)) continue;
    const tokens = line.trim().split(/\s+/).filter((t) => parseChordText(t) !== null);
    if (!tokens.some((t) => /^\(?H/.test(t))) continue;
    if (tokens.length > 1) return true;
    if (++lone >= 2) return true;
  }
  return false;
}
