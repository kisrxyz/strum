import { describe, expect, it } from 'vitest';
import { FRETS, noteRole, placeNote, positionsOf } from './fretboard';
import { TUNINGS } from './tunings';

const STANDARD = TUNINGS.standard.strings;
const C_MAJOR = { root: 0, quality: 'maj' } as const;
const C_KEY = { tonic: 0, mode: 'major' } as const;

describe('positionsOf', () => {
  it('finds every place of a pitch class', () => {
    const e = positionsOf(4, STANDARD, 0);
    expect(e).toContainEqual({ string: 0, fret: 0 });
    expect(e).toContainEqual({ string: 5, fret: 12 });
    expect(e).toContainEqual({ string: 1, fret: 7 });
    expect(e).toContainEqual({ string: 4, fret: 5 });
    expect(e).not.toContainEqual({ string: 0, fret: 24 });
    for (const p of e) expect((STANDARD[p.string] + p.fret) % 12).toBe(4);
    expect(e.every((p) => p.fret <= FRETS)).toBe(true);
  });

  it('starts at the capo and stops at maxFret', () => {
    expect(positionsOf(4, STANDARD, 3).every((p) => p.fret >= 3)).toBe(true);
    expect(positionsOf(4, STANDARD, 0, 5).every((p) => p.fret <= 5)).toBe(true);
  });
});

describe('placeNote', () => {
  it('takes the lowest fret without a previous note', () => {
    expect(placeNote(64, STANDARD, 0, null)).toEqual({ string: 5, fret: 0 });
    expect(placeNote(76, STANDARD, 0, null)).toEqual({ string: 5, fret: 12 });
  });

  it('stays near the previous note', () => {
    expect(placeNote(64, STANDARD, 0, { string: 3, fret: 8 })).toEqual({ string: 3, fret: 9 });
    expect(placeNote(64, STANDARD, 0, { string: 3, fret: 2 })).toEqual({ string: 5, fret: 0 });
  });

  it('never goes below the capo', () => {
    expect(placeNote(64, STANDARD, 3, null)).toEqual({ string: 4, fret: 5 });
    for (let midi = 40; midi <= 86; midi++) {
      const pos = placeNote(midi, STANDARD, 3, { string: 0, fret: 3 });
      if (pos) expect(pos.fret).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives null for a note the guitar cannot play', () => {
    expect(placeNote(30, STANDARD, 0, null)).toBeNull();
    expect(placeNote(64 + FRETS + 1, STANDARD, 0, null)).toBeNull();
  });
});

describe('noteRole', () => {
  it('tells chord notes, scale notes and the rest apart', () => {
    expect(noteRole(4, C_MAJOR, C_KEY)).toBe('chord');
    expect(noteRole(2, C_MAJOR, C_KEY)).toBe('scale');
    expect(noteRole(1, C_MAJOR, C_KEY)).toBe('out');
    expect(noteRole(16, C_MAJOR, C_KEY)).toBe('chord');
  });

  it('goes by the key alone without a chord, and never calls a note out without a key', () => {
    expect(noteRole(2, null, C_KEY)).toBe('scale');
    expect(noteRole(1, null, C_KEY)).toBe('out');
    expect(noteRole(1, C_MAJOR, null)).toBe('scale');
  });
});
