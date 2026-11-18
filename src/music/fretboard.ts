// Notes on the fretboard: where a note can be played and what it is to the chord and the key.
import { chordTones, pitchClass, type Chord } from './chords';
import { scalePitchClasses, type Key } from './keys';

export const FRETS = 22;

/**
 * A place on the fretboard. `string`: 0 = 6th (lowest) … 5 = 1st. `fret` is absolute: with a capo
 * every position has `fret >= capo`, and `fret === capo` is the string ringing open at the capo.
 */
export interface FretPos {
  string: number;
  fret: number;
}

/** warm = a chord note, neutral = in the key, cold = outside it. */
export type NoteRole = 'chord' | 'scale' | 'out';

/** Every place of a pitch class between the capo and `maxFret`, string by string, low frets first. */
export function positionsOf(pc: number, strings: readonly number[], capo: number, maxFret = FRETS): FretPos[] {
  const out: FretPos[] = [];
  const want = pitchClass(pc);
  for (let string = 0; string < strings.length; string++) {
    for (let fret = Math.max(0, capo); fret <= maxFret; fret++) {
      if (pitchClass(strings[string] + fret) === want) out.push({ string, fret });
    }
  }
  return out;
}

/** Every place of an exact pitch (MIDI) between the capo and `maxFret`, low strings first. */
export function placesOf(midi: number, strings: readonly number[], capo: number, maxFret = FRETS): FretPos[] {
  const note = Math.round(midi);
  const out: FretPos[] = [];
  for (let string = 0; string < strings.length; string++) {
    const fret = note - strings[string];
    if (fret >= Math.max(0, capo) && fret <= maxFret) out.push({ string, fret });
  }
  return out;
}

/**
 * Where a played note (exact pitch) most likely was: the place nearest the previous note (moving
 * along the neck costs more than across strings), else the lowest fret. Null when unplayable.
 */
export function placeNote(midi: number, strings: readonly number[], capo: number, previous: FretPos | null): FretPos | null {
  const note = Math.round(midi);
  let best: FretPos | null = null;
  let bestCost = Infinity;
  for (let string = 0; string < strings.length; string++) {
    const fret = note - strings[string];
    if (fret < capo || fret < 0 || fret > FRETS) continue;
    const cost = previous ? Math.abs(fret - previous.fret) + 0.5 * Math.abs(string - previous.string) : fret;
    if (cost < bestCost || (cost === bestCost && best !== null && fret < best.fret)) {
      best = { string, fret };
      bestCost = cost;
    }
  }
  return best;
}

/**
 * What a note is to the current chord and the key. Without a key nothing is called out of the key:
 * a note outside the chord is then neutral.
 */
export function noteRole(pc: number, chord: Chord | null, key: Key | null): NoteRole {
  const note = pitchClass(pc);
  if (chord && chordTones(chord).includes(note)) return 'chord';
  if (!key) return 'scale';
  return scalePitchClasses(key).includes(note) ? 'scale' : 'out';
}
