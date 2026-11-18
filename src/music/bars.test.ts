import { describe, expect, it } from 'vitest';
import type { Section } from '../song/types';
import { barAt, buildBars, sectionAt, snapToBar, stepSection } from './bars';

/** from, from + step, … up to `to`, rounded to ms (no float drift). */
const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let i = 0; from + i * step <= to + 1e-9; i++) out.push(Math.round((from + i * step) * 1000) / 1000);
  return out;
};

// 120 BPM in 4/4: beats every 0.5 s from 0.5 to 20, a bar line every 2 s.
const BEATS = range(0.5, 20, 0.5);
const DOWNBEATS = range(0.5, 18.5, 2);

describe('buildBars', () => {
  it('makes a bar from each downbeat to the next', () => {
    const bars = buildBars(BEATS, DOWNBEATS, 0, 21);
    expect(bars).toHaveLength(10);
    expect(bars[0]).toEqual({ number: 1, start: 0.5, end: 2.5, beats: [0.5, 1, 1.5, 2] });
    expect(bars[9]).toEqual({ number: 10, start: 18.5, end: 20.5, beats: [18.5, 19, 19.5, 20] });
  });

  it('ends the last bar one beat after its last beat, but not after the song', () => {
    expect(buildBars(BEATS, DOWNBEATS, 0, 20.2).at(-1)?.end).toBeCloseTo(20.2, 9);
  });

  it('a beat before the first downbeat is a pickup, bar 0', () => {
    const bars = buildBars([0, ...BEATS], DOWNBEATS, 0, 21);
    expect(bars[0]).toEqual({ number: 0, start: 0, end: 0.5, beats: [0] });
    expect(bars[1]).toMatchObject({ number: 1, start: 0.5 });
    expect(bars).toHaveLength(11);
  });

  it('moves the bar lines by whole beats', () => {
    const later = buildBars(BEATS, DOWNBEATS, 1, 21);
    expect(later[0]).toEqual({ number: 0, start: 0.5, end: 1, beats: [0.5] });
    expect(later[1]).toMatchObject({ number: 1, start: 1, end: 3, beats: [1, 1.5, 2, 2.5] });
    const earlier = buildBars(BEATS, DOWNBEATS, -1, 21);
    expect(earlier[0]).toEqual({ number: 0, start: 0.5, end: 2, beats: [0.5, 1, 1.5] });
    expect(earlier[1]).toMatchObject({ number: 1, start: 2, end: 4 });
  });

  it('matches downbeats to beats within 50 ms', () => {
    const jittered = DOWNBEATS.map((t, i) => t + (i % 2 ? 0.03 : -0.03));
    expect(buildBars(BEATS, jittered, 0, 21)).toEqual(buildBars(BEATS, DOWNBEATS, 0, 21));
  });

  it('fills in bar lines the downbeat tracker missed', () => {
    const gappy = DOWNBEATS.filter((t) => t < 3 || t > 10);
    expect(buildBars(BEATS, gappy, 0, 21).map((b) => b.start)).toEqual(DOWNBEATS);
  });

  it('keeps 3/4', () => {
    const bars = buildBars(BEATS, range(0.5, 20, 1.5), 0, 21);
    expect(bars[0].beats).toEqual([0.5, 1, 1.5]);
    expect(bars.slice(0, -1).every((b) => b.beats.length === 3)).toBe(true);
  });

  it('without downbeats, a bar every four beats', () => {
    const bars = buildBars(BEATS, [], 0, 21);
    expect(bars).toHaveLength(10);
    expect(bars[0]).toEqual({ number: 1, start: 0.5, end: 2.5, beats: [0.5, 1, 1.5, 2] });
  });

  it('no bars from fewer than four beats', () => {
    expect(buildBars([], [], 0, 10)).toEqual([]);
    expect(buildBars([0.5], [0.5], 0, 10)).toEqual([]);
    expect(buildBars([0.5, 1, 1.5], [0.5], 0, 10)).toEqual([]);
    expect(buildBars([0.5, 1, 1.5, 2], [0.5], 0, 10)).toHaveLength(1);
  });
});

describe('barAt / snapToBar', () => {
  const bars = buildBars(BEATS, DOWNBEATS, 0, 21);

  it('finds the bar a moment is in', () => {
    expect(barAt(bars, 0.5)).toBe(0);
    expect(barAt(bars, 2.49)).toBe(0);
    expect(barAt(bars, 2.5)).toBe(1);
    expect(barAt(bars, 20.4)).toBe(9);
    expect(barAt(bars, 0.2)).toBe(-1);
    expect(barAt(bars, 20.5)).toBe(-1);
    expect(barAt([], 1)).toBe(-1);
  });

  it('snaps to the nearest bar line', () => {
    expect(snapToBar(bars, 2.4)).toBe(2.5);
    expect(snapToBar(bars, 2.6)).toBe(2.5);
    expect(snapToBar(bars, 3.6)).toBe(4.5);
    expect(snapToBar(bars, 0)).toBe(0.5);
    expect(snapToBar(bars, 30)).toBe(20.5);
    expect(snapToBar([], 3.3)).toBe(3.3);
  });
});

describe('sections', () => {
  const sections: Section[] = [
    { start: 0, end: 10, kind: 'intro', name: 'Вступление' },
    { start: 10, end: 30, kind: 'verse', name: 'Куплет 1' },
    { start: 30, end: 50, kind: 'chorus', name: 'Припев 1' },
  ];

  it('finds the section a moment is in', () => {
    expect(sectionAt(sections, 0)).toBe(0);
    expect(sectionAt(sections, 10)).toBe(1);
    expect(sectionAt(sections, 49.9)).toBe(2);
    expect(sectionAt(sections, 50)).toBe(-1);
    expect(sectionAt([], 5)).toBe(-1);
  });

  it('steps to the next section', () => {
    expect(stepSection(sections, 5, 1)).toBe(1);
    expect(stepSection(sections, 10, 1)).toBe(2);
    expect(stepSection(sections, 35, 1)).toBe(-1);
  });

  it('steps back to the start of the section first, like a CD player', () => {
    expect(stepSection(sections, 15, -1)).toBe(1);
    expect(stepSection(sections, 11, -1)).toBe(0);
    expect(stepSection(sections, 1, -1)).toBe(0);
    expect(stepSection(sections, 60, -1)).toBe(2);
    expect(stepSection([], 5, -1)).toBe(-1);
  });
});
