// Keys: how notes are spelled in them, their scales and the degrees of a note against a root.
import { noteName, pitchClass, type Spelling } from './chords';

export interface Key {
  /** Pitch class of the tonic: 0 = C … 11 = B. */
  tonic: number;
  mode: 'major' | 'minor';
}

// F B♭ E♭ A♭ D♭ G♭ major and their relative minors D G C F B♭ E♭ are written with flats.
const FLAT_MAJOR: ReadonlySet<number> = new Set([5, 10, 3, 8, 1, 6]);
const FLAT_MINOR: ReadonlySet<number> = new Set([2, 7, 0, 5, 10, 3]);
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const DEGREES = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];

/** Sharps or flats, as the key is written. Without a key: sharps, like the tuner. */
export function keySpelling(key: Key | null): Spelling {
  if (!key) return 'sharps';
  const flats = key.mode === 'major' ? FLAT_MAJOR : FLAT_MINOR;
  return flats.has(pitchClass(key.tonic)) ? 'flats' : 'sharps';
}

/** «Am», «E♭». */
export function keyName(key: Key, spelling: Spelling): string {
  return noteName(key.tonic, spelling) + (key.mode === 'minor' ? 'm' : '');
}

/** The seven notes of the major or natural minor scale, from the tonic up. */
export function scalePitchClasses(key: Key): number[] {
  return (key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE).map((i) => pitchClass(key.tonic + i));
}

/** The degree of a note against a chord root: 1 ♭2 2 ♭3 3 4 ♭5 5 ♭6 6 ♭7 7. */
export function degreeName(pc: number, root: number): string {
  return DEGREES[pitchClass(pc - root)];
}

export function transposeKey(key: Key, semitones: number): Key {
  return { tonic: pitchClass(key.tonic + semitones), mode: key.mode };
}
