// How the song's chords are shown to the player: the chord that sounds (the song's pitch shift,
// «простые аккорды») and the shape the hand plays (tuning and capo taken off).
import { parseChord, pitchClass, simplify, transposeChord, type Chord, type Spelling } from './chords';
import { keySpelling, transposeKey, type Key } from './keys';
import { TUNINGS } from './tunings';
import type { ChordLabel, TuningId } from '../song/types';

export interface ViewOptions {
  /** The song's pitch shift. */
  semitones: number;
  capo: number;
  tuning: TuningId;
  /** «Простые аккорды». */
  simple: boolean;
}

/** Semitones from what sounds to the shape played: in E♭ tuning and with a capo the shapes are lower. */
const toShape = (o: ViewOptions): number => -TUNINGS[o.tuning].shift - o.capo;

/** The chord as it sounds now: moved with the song, simplified when asked. Null for N, X. */
export function soundingChord(label: ChordLabel, o: ViewOptions): Chord | null {
  const chord = parseChord(label);
  if (!chord) return null;
  const moved = transposeChord(chord, o.semitones);
  return o.simple ? simplify(moved) : moved;
}

/** The chord as the hand plays it: named from the capo, E♭ tuning named by its shapes. */
export function shapeChord(label: ChordLabel, o: ViewOptions): Chord | null {
  const chord = soundingChord(label, o);
  return chord ? transposeChord(chord, toShape(o)) : null;
}

/** Open strings at the capo (MIDI, 6th first): what `voicings()` takes with the sounding chord. */
export function openStrings(o: ViewOptions): number[] {
  return TUNINGS[o.tuning].strings.map((note) => note + o.capo);
}

/** The analysis' key moved like the shapes (song pitch shift, tuning, capo). */
export function shapeKey(key: Key | null, o: ViewOptions): Key | null {
  return key ? transposeKey(key, o.semitones + toShape(o)) : null;
}

/** Sharps or flats for the shape names: those of the key the shapes are in. */
export function shapeSpelling(key: Key | null, o: ViewOptions): Spelling {
  return keySpelling(shapeKey(key, o));
}

/** A sounding pitch class (e.g. a fretboard note) as a note of the shapes, to name it like the chords. */
export function shapePitchClass(pc: number, o: ViewOptions): number {
  return pitchClass(pc + toShape(o));
}
