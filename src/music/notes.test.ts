import { describe, expect, it } from 'vitest';
import type { GuitarNote } from '../song/types';
import { placesOf } from './fretboard';
import { expectedAt, matchesNote } from './match';
import { editNote, nextNote, noteAt, noteRange, phraseAt, phraseLoop, phrases, stepPhrase } from './notes';

const n = (start: number, end: number, midi: number): GuitarNote => ({ start, end, midi });

// Two phrases (3 and 4 notes) and a stray pair between them.
const NOTES: GuitarNote[] = [
  n(1.0, 1.2, 64),
  n(1.3, 1.5, 67),
  n(1.6, 2.0, 69),
  n(3.0, 3.2, 72), // stray: 1 s after the phrase
  n(3.3, 3.4, 71),
  n(5.0, 5.2, 69),
  n(5.3, 5.5, 67),
  n(5.6, 5.7, 64),
  n(5.8, 6.4, 62),
];

describe('notes in time', () => {
  it('finds the note sounding now and the next one', () => {
    expect(noteAt(NOTES, 1.1)).toBe(0);
    expect(noteAt(NOTES, 1.25)).toBe(-1); // a pause
    expect(noteAt(NOTES, 0.5)).toBe(-1);
    expect(nextNote(NOTES, 1.1)).toBe(1);
    expect(nextNote(NOTES, 0)).toBe(0);
    expect(nextNote(NOTES, 6.0)).toBe(-1);
    expect(noteAt([], 1)).toBe(-1);
    expect(nextNote([], 1)).toBe(-1);
  });

  it('knows the range for the lane', () => {
    expect(noteRange(NOTES, 0, 0)).toEqual({ low: 62, high: 72 });
    expect(noteRange(NOTES)).toEqual({ low: 61, high: 73 }); // at least an octave
    expect(noteRange([])).toBeNull();
    // a stray low note does not stretch the lane
    const solo = [n(0, 1, 40), ...Array.from({ length: 40 }, (_, i) => n(i + 1, i + 1.5, 64 + (i % 14)))];
    expect(noteRange(solo)).toEqual({ low: 64, high: 77 });
  });
});

describe('phrases', () => {
  it('splits at pauses and leaves out runs that are too short', () => {
    const list = phrases(NOTES);
    expect(list).toEqual([
      { start: 1.0, end: 2.0, first: 0, last: 2 },
      { start: 5.0, end: 6.4, first: 5, last: 8 },
    ]);
    expect(phrases([])).toEqual([]);
    expect(phrases(NOTES.slice(0, 2))).toEqual([]);
  });

  it('steps through phrases like sections', () => {
    const list = phrases(NOTES);
    expect(phraseAt(list, 1.5)).toBe(0);
    expect(phraseAt(list, 3.0)).toBe(-1);
    expect(stepPhrase(list, 0, 1)).toBe(0);
    expect(stepPhrase(list, 1.5, 1)).toBe(1);
    expect(stepPhrase(list, 5.5, 1)).toBe(-1);
    expect(stepPhrase(list, 5.5, -1)).toBe(0); // just into the second: to the one before
    expect(stepPhrase(list, 4.0, -1)).toBe(0); // between: the one before
    expect(stepPhrase(list, 0.5, -1)).toBe(-1);
    const long = phrases([n(10, 11, 60), n(11.1, 12, 62), n(12.1, 14, 64)]);
    expect(stepPhrase(long, 13, -1)).toBe(0); // more than 2 s in: its own start
  });

  it('loops a phrase on the beats around it', () => {
    const [first] = phrases(NOTES);
    const beats = [0.5, 0.95, 1.4, 1.85, 2.3, 2.75];
    expect(phraseLoop(first, beats)).toEqual({ start: 0.95, end: 2.3 });
    const air = phraseLoop(first, []);
    expect(air.start).toBeCloseTo(0.8);
    expect(air.end).toBeCloseTo(2.2);
    expect(phraseLoop({ start: 0.1, end: 0.5, first: 0, last: 2 }, []).start).toBe(0);
  });
});

describe('note edits', () => {
  it('moves a note by a semitone and keeps only what song.json stores', () => {
    const notes = [{ ...n(1, 2, 64), conf: 0.9 }, n(2, 3, 65)];
    expect(editNote(notes, 0, 'up')).toEqual([n(1, 2, 65), n(2, 3, 65)]);
    expect(editNote(notes, 1, 'down')).toEqual([n(1, 2, 64), n(2, 3, 64)]);
    expect(editNote(notes, 0, 'remove')).toEqual([n(2, 3, 65)]);
    expect(editNote(notes, 5, 'up')).toEqual([n(1, 2, 64), n(2, 3, 65)]);
    expect(editNote([n(0, 1, 100)], 0, 'up')).toEqual([n(0, 1, 100)]);
  });
});

describe('«совпало»', () => {
  it('expects the notes around now, moved with the song', () => {
    expect(expectedAt(NOTES, 1.1)).toEqual([64]);
    expect(expectedAt(NOTES, 1.25)).toEqual([64, 67]); // both within 0.15 s
    expect(expectedAt(NOTES, 2.5)).toEqual([]);
    expect(expectedAt(NOTES, 1.1, 2)).toEqual([66]);
  });

  it('matches the same note in the same octave', () => {
    expect(matchesNote(64.3, [64])).toBe(true);
    expect(matchesNote(63.6, [64])).toBe(true);
    expect(matchesNote(65, [64])).toBe(false);
    expect(matchesNote(76, [64])).toBe(false); // an octave up is another note
    expect(matchesNote(null, [64])).toBe(false);
    expect(matchesNote(64, [])).toBe(false);
  });

  it('places an exact pitch everywhere on the neck', () => {
    const standard = [40, 45, 50, 55, 59, 64];
    expect(placesOf(64, standard, 0)).toEqual([
      { string: 1, fret: 19 }, // the 6th string would need fret 24
      { string: 2, fret: 14 },
      { string: 3, fret: 9 },
      { string: 4, fret: 5 },
      { string: 5, fret: 0 },
    ]);
    expect(placesOf(64, standard, 5).map((p) => p.string)).toEqual([1, 2, 3, 4]); // the open E is under the capo
    expect(placesOf(30, standard, 0)).toEqual([]);
  });
});
