import { describe, expect, it } from 'vitest';
import type { Bar } from '../music/bars';
import { chartRows, rowAt } from './chart';
import type { ChordSegment, Section } from './types';

/** Bars of 2 s with four beats each; bar `first` starts at `first * 2 - 2` seconds. */
function bars(count: number, first = 1, beatsPerBar = 4): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const start = i * 2;
    return {
      number: first + i,
      start,
      end: start + 2,
      beats: Array.from({ length: beatsPerBar }, (_, b) => start + (b * 2) / beatsPerBar),
    };
  });
}

const seg = (start: number, end: number, chord: string): ChordSegment => ({ start, end, chord });
const section = (start: number, end: number, kind: Section['kind'], name = ''): Section => ({ start, end, kind, name });

describe('chartRows', () => {
  it('groups four bars a row', () => {
    const rows = chartRows(bars(9), [], []);
    expect(rows.map((r) => r.bars.map((b) => b.number))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  });

  it('starts a row where a section starts', () => {
    const rows = chartRows(bars(6), [], [section(0, 4, 'intro'), section(4, 12, 'verse')]);
    expect(rows.map((r) => r.bars.map((b) => b.number))).toEqual([[1, 2], [3, 4, 5, 6]]);
    expect(rows.map((r) => r.section)).toEqual(['Intro', 'Verse 1']);
  });

  it('names a section only on its first row', () => {
    const rows = chartRows(bars(6), [], [section(0, 12, 'verse')]);
    expect(rows.map((r) => r.section)).toEqual(['Verse 1', null]);
    // A tab-song keeps the file's own marker.
    const fromFile = chartRows(bars(6), [], [section(0, 12, 'verse', 'Куплет')], 4, true);
    expect(fromFile.map((r) => r.section)).toEqual(['Куплет', null]);
  });

  it('places a chord at its beat', () => {
    const rows = chartRows(bars(1), [seg(0, 1, 'A:min'), seg(1, 2, 'E:maj')], []);
    expect(rows[0].bars[0].chords).toEqual([
      { beat: 0, index: 0 },
      { beat: 2, index: 1 },
    ]);
  });

  it('continues the sounding chord at the bar start', () => {
    const rows = chartRows(bars(2), [seg(0, 4, 'A:min')], []);
    expect(rows[0].bars[1].chords).toEqual([{ beat: 0, index: 0 }]);
  });

  it('skips repeats and no-chord', () => {
    const track = [seg(0, 0.5, 'A:min'), seg(0.5, 1, 'A:min'), seg(1, 2, 'N')];
    const rows = chartRows(bars(1), track, []);
    expect(rows[0].bars[0].chords).toEqual([{ beat: 0, index: 0 }]);
  });

  it('skips bars before bar 1', () => {
    const rows = chartRows(bars(3, 0), [], []);
    expect(rows[0].bars.map((b) => b.number)).toEqual([1, 2]);
  });

  it('keeps the beat count of a 3/4 bar', () => {
    const rows = chartRows(bars(1, 1, 3), [seg(0, 1.4, 'G:maj'), seg(1.4, 2, 'D:maj')], []);
    expect(rows[0].bars[0].beats).toBe(3);
    expect(rows[0].bars[0].chords.map((c) => c.beat)).toEqual([0, 2]);
  });
});

describe('rowAt', () => {
  const rows = chartRows(bars(12), [], []);
  it('is the first row before the first bar', () => expect(rowAt(rows, -1)).toBe(0));
  it('finds the row the time is in', () => expect(rowAt(rows, 9)).toBe(1));
  it('is the last row after the end', () => expect(rowAt(rows, 100)).toBe(2));
  it('is −1 without rows', () => expect(rowAt([], 3)).toBe(-1));
});
