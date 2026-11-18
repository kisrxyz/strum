// Pitch ↔ note math for the tuner and, later, the fretboard.

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
export const SOLFEGE = ['до', 'до♯', 'ре', 'ре♯', 'ми', 'фа', 'фа♯', 'соль', 'соль♯', 'ля', 'ля♯', 'си'] as const;

/** Open strings from the 6th (low E2) to the 1st (E4), as MIDI notes. */
export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64] as const;

export interface NoteReading {
  /** Nearest MIDI note. */
  midi: number;
  name: (typeof NOTE_NAMES)[number];
  solfege: (typeof SOLFEGE)[number];
  octave: number;
  /** Deviation from the nearest note, -50..+50. */
  cents: number;
}

export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function describePitch(freq: number, a4 = 440): NoteReading {
  const exact = freqToMidi(freq, a4);
  const midi = Math.round(exact);
  const pitchClass = ((midi % 12) + 12) % 12;
  return {
    midi,
    name: NOTE_NAMES[pitchClass],
    solfege: SOLFEGE[pitchClass],
    octave: Math.floor(midi / 12) - 1,
    cents: (exact - midi) * 100,
  };
}

/**
 * Which open string the note is closest to, or null if it is far from all of them.
 * `strings` are the open strings as MIDI notes, 6th string first (see src/music/tunings.ts).
 */
export function nearestString(
  midi: number,
  strings: readonly number[] = STANDARD_TUNING,
): { stringNumber: number; cents: number } | null {
  if (!strings.length) return null;
  let best = 0;
  for (let i = 1; i < strings.length; i++) {
    if (Math.abs(midi - strings[i]) < Math.abs(midi - strings[best])) best = i;
  }
  const cents = (midi - strings[best]) * 100;
  return Math.abs(cents) <= 150 ? { stringNumber: strings.length - best, cents } : null;
}

export type TuneState = 'in' | 'close' | 'off';

export function tuneState(cents: number): TuneState {
  const off = Math.abs(cents);
  if (off <= 3) return 'in';
  if (off <= 15) return 'close';
  return 'off';
}
