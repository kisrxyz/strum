import { describe, expect, it } from 'vitest';
import {
  QUALITIES,
  chordIntervals,
  chordLabel,
  chordName,
  chordTones,
  noteName,
  parseChord,
  simplify,
  transposeChord,
} from './chords';

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ALL_LABELS = ROOTS.flatMap((root) => QUALITIES.map((q) => (q === 'maj' ? root : `${root}:${q}`)));

describe('parseChord / chordLabel', () => {
  it('reads the service notation', () => {
    expect(parseChord('C#:min')).toEqual({ root: 1, quality: 'min' });
    expect(parseChord('A')).toEqual({ root: 9, quality: 'maj' });
    expect(parseChord('C:maj')).toEqual({ root: 0, quality: 'maj' });
    expect(parseChord('B:hdim7')).toEqual({ root: 11, quality: 'hdim7' });
  });

  it('accepts flats, in ASCII or as ♭, and ♯', () => {
    expect(parseChord('Bb:7')).toEqual({ root: 10, quality: '7' });
    expect(parseChord('B♭:7')).toEqual({ root: 10, quality: '7' });
    expect(parseChord('E♭')).toEqual({ root: 3, quality: 'maj' });
    expect(parseChord('F♯:min')).toEqual({ root: 6, quality: 'min' });
    expect(parseChord('Cb')).toEqual({ root: 11, quality: 'maj' });
  });

  it('gives null for no chord, an unknown chord and garbage', () => {
    for (const label of ['N', 'X', 'H', '', 'c', 'C:foo', 'C:constructor', 'C:min/5', 'Cm']) {
      expect(parseChord(label)).toBeNull();
    }
  });

  it('writes sharps and a bare root for major', () => {
    expect(chordLabel({ root: 0, quality: 'maj' })).toBe('C');
    expect(chordLabel({ root: 10, quality: '7' })).toBe('A#:7');
    expect(chordLabel({ root: -3, quality: 'min' })).toBe('A:min');
  });

  it('round-trips all 168 BTC chord labels', () => {
    expect(ALL_LABELS).toHaveLength(168);
    for (const label of ALL_LABELS) {
      const chord = parseChord(label);
      expect(chord).not.toBeNull();
      expect(chordLabel(chord!)).toBe(label);
    }
  });

  it('lists the qualities in the editor order', () => {
    expect(QUALITIES).toEqual(['maj', 'min', '7', 'min7', 'maj7', 'sus4', 'sus2', 'dim', 'aug', 'maj6', 'min6', 'dim7', 'hdim7', 'minmaj7']);
  });
});

describe('chord tones', () => {
  it('gives intervals and pitch classes, root first', () => {
    expect(chordIntervals('hdim7')).toEqual([0, 3, 6, 10]);
    expect(chordTones({ root: 9, quality: 'min' })).toEqual([9, 0, 4]);
    expect(chordTones({ root: 7, quality: '7' })).toEqual([7, 11, 2, 5]);
    expect(chordTones({ root: 2, quality: 'sus4' })).toEqual([2, 7, 9]);
  });

  it('simplifies to major or minor', () => {
    expect(simplify({ root: 9, quality: 'min7' })).toEqual({ root: 9, quality: 'min' });
    expect(simplify({ root: 7, quality: '7' })).toEqual({ root: 7, quality: 'maj' });
    expect(simplify({ root: 11, quality: 'dim' })).toEqual({ root: 11, quality: 'min' });
    expect(simplify({ root: 9, quality: 'sus4' })).toEqual({ root: 9, quality: 'maj' });
    expect(simplify({ root: 0, quality: 'hdim7' })).toEqual({ root: 0, quality: 'min' });
    expect(simplify({ root: 0, quality: 'aug' })).toEqual({ root: 0, quality: 'maj' });
  });

  it('transposes round the octave', () => {
    expect(transposeChord({ root: 11, quality: 'min' }, 2)).toEqual({ root: 1, quality: 'min' });
    expect(transposeChord({ root: 0, quality: 'maj' }, -1)).toEqual({ root: 11, quality: 'maj' });
  });
});

describe('names', () => {
  it('names notes with sharps or flats', () => {
    expect(noteName(10, 'flats')).toBe('B♭');
    expect(noteName(10, 'sharps')).toBe('A♯');
    expect(noteName(1, 'flats')).toBe('D♭');
    expect(noteName(4, 'flats')).toBe('E');
    expect(noteName(-1, 'sharps')).toBe('B');
  });

  it('names chords like a songbook', () => {
    expect(chordName({ root: 10, quality: 'maj' }, 'flats')).toBe('B♭');
    expect(chordName({ root: 6, quality: 'min' }, 'sharps')).toBe('F♯m');
    expect(chordName({ root: 11, quality: 'hdim7' }, 'sharps')).toBe('Bm7♭5');
    expect(chordName({ root: 0, quality: 'minmaj7' }, 'sharps')).toBe('Cm(maj7)');
    expect(chordName({ root: 9, quality: 'maj6' }, 'sharps')).toBe('A6');
    expect(chordName({ root: 2, quality: 'sus4' }, 'sharps')).toBe('Dsus4');
    expect(chordName(null, 'sharps')).toBe('—');
  });
});
