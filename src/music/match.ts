// «Совпало»: does the note you play match the note of the recording or of the tab (SPEC §3: a glow, no scores).
import type { GuitarNote } from '../song/types';

/** The recording's notes can be this early or late to you (the player's output delay, the hand), seconds. */
export const MATCH_SLACK = 0.15;

/**
 * The pitches (MIDI, as they sound now: moved by the song's `semitones`) of the recording's notes
 * that sound within `slack` seconds of `t`.
 */
export function expectedAt(notes: readonly GuitarNote[], t: number, semitones = 0, slack = MATCH_SLACK): number[] {
  const out: number[] = [];
  for (const note of notes) {
    if (note.start > t + slack) break; // sorted by start
    if (note.end >= t - slack) out.push(note.midi + semitones);
  }
  return out;
}

/** The played pitch (the tuner's MIDI, may be fractional) is one of the expected notes: same note, same octave. */
export function matchesNote(played: number | null, expected: readonly number[]): boolean {
  if (played === null || !Number.isFinite(played)) return false;
  const note = Math.round(played);
  return expected.some((midi) => Math.round(midi) === note);
}
