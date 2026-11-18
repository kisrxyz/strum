import { describe, expect, it } from 'vitest';
import type { Analysis, ChordSegment, Song } from '../song/types';
import { chordAt, effectiveChords, mergeWithPrevious, nextChange, setChord, splitAt, visibility } from './track';

const seg = (start: number, end: number, chord: string): ChordSegment => ({ start, end, chord });
const BEATS = Array.from({ length: 21 }, (_, i) => i * 0.5);

describe('effectiveChords', () => {
  const analysis = { chords: [seg(0, 4, 'C')] } as Analysis;

  it('takes the user edits first, then the analysis', () => {
    expect(effectiveChords({ chords: [seg(0, 4, 'G')] } as Song, analysis)).toEqual([seg(0, 4, 'G')]);
    expect(effectiveChords({ chords: null } as Song, analysis)).toEqual([seg(0, 4, 'C')]);
    expect(effectiveChords({ chords: null } as Song, null)).toEqual([]);
  });
});

describe('chordAt / nextChange', () => {
  const track = [seg(0, 2, 'C'), seg(2, 4, 'G'), seg(4, 6, 'A:min')];

  it('finds the chord at a moment', () => {
    expect(chordAt(track, 0)).toBe(0);
    expect(chordAt(track, 1.99)).toBe(0);
    expect(chordAt(track, 2)).toBe(1);
    expect(chordAt(track, 5.9)).toBe(2);
    expect(chordAt(track, 6)).toBe(-1);
    expect(chordAt(track, -1)).toBe(-1);
    expect(chordAt([], 1)).toBe(-1);
  });

  it('finds the next change', () => {
    expect(nextChange(track, 1)).toBe(2);
    expect(nextChange(track, 2)).toBe(4);
    expect(nextChange(track, 5)).toBeNull();
    expect(nextChange(track, -3)).toBe(0);
  });

  it('a split with the same chord on both sides is not a change', () => {
    expect(nextChange([seg(0, 2, 'C'), seg(2, 4, 'C'), seg(4, 6, 'G')], 1)).toBe(4);
  });
});

describe('editing', () => {
  it('splits at the beat nearest the click and keeps both halves apart', () => {
    expect(splitAt([seg(0, 4, 'C')], 1.9, BEATS)).toEqual([seg(0, 2, 'C'), seg(2, 4, 'C')]);
  });

  it('then a new chord goes into one half', () => {
    const split = splitAt([seg(0, 4, 'C')], 1.9, BEATS);
    expect(setChord(split, 1, 'G')).toEqual([seg(0, 2, 'C'), seg(2, 4, 'G')]);
  });

  it('splits at the moment itself without beats, and not outside the chords', () => {
    expect(splitAt([seg(0, 4, 'C')], 1.3, [])).toEqual([seg(0, 1.3, 'C'), seg(1.3, 4, 'C')]);
    expect(splitAt([seg(0, 4, 'C')], 5, BEATS)).toEqual([seg(0, 4, 'C')]);
    expect(splitAt([seg(0, 4, 'C')], 0, [0])).toEqual([seg(0, 4, 'C')]);
  });

  it('merges a chord set to the same as its neighbour', () => {
    expect(setChord([seg(0, 2, 'C'), seg(2, 4, 'G')], 1, 'C')).toEqual([seg(0, 4, 'C')]);
    expect(setChord([seg(0, 2, 'C'), seg(2, 4, 'G'), seg(4, 6, 'A:min')], 1, 'A:min')).toEqual([seg(0, 2, 'C'), seg(2, 6, 'A:min')]);
  });

  it('ignores an index out of range', () => {
    expect(setChord([seg(0, 2, 'C')], 3, 'G')).toEqual([seg(0, 2, 'C')]);
  });

  it('merges a chord into the previous one', () => {
    expect(mergeWithPrevious([seg(0, 2, 'C'), seg(2, 4, 'G'), seg(4, 6, 'A:min')], 1)).toEqual([seg(0, 4, 'C'), seg(4, 6, 'A:min')]);
    expect(mergeWithPrevious([seg(0, 2, 'C'), seg(2, 4, 'G'), seg(4, 6, 'C')], 1)).toEqual([seg(0, 6, 'C')]);
    expect(mergeWithPrevious([seg(0, 2, 'C'), seg(2, 4, 'G')], 0)).toEqual([seg(0, 2, 'C'), seg(2, 4, 'G')]);
  });

  it('keeps the track sorted and without gaps (index = position in the track given)', () => {
    const messy = [seg(4, 6, 'A:min'), seg(0, 2, 'C'), seg(2.5, 4, 'G'), seg(6, 6, 'F')];
    expect(setChord(messy, 0, 'E:min')).toEqual([seg(0, 2.5, 'C'), seg(2.5, 4, 'G'), seg(4, 6, 'E:min')]);
  });
});

describe('visibility', () => {
  it('shows everything in «Играть»', () => {
    for (const reveal of [0, 1, 2, 3] as const) {
      expect(visibility('play', reveal)).toEqual({ changes: true, currentName: true, allNames: true, fingerings: true });
    }
  });

  it('opens «Снять на слух» step by step', () => {
    expect(visibility('ear', 0)).toEqual({ changes: false, currentName: false, allNames: false, fingerings: false });
    expect(visibility('ear', 1)).toEqual({ changes: true, currentName: false, allNames: false, fingerings: false });
    expect(visibility('ear', 2)).toEqual({ changes: true, currentName: true, allNames: false, fingerings: false });
    expect(visibility('ear', 3)).toEqual({ changes: true, currentName: true, allNames: true, fingerings: true });
  });
});
