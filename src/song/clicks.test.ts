import { describe, expect, it } from 'vitest';
import { buildBars } from '../music/bars';
import { clicksBetween, countIn } from './clicks';
import { positionAt, type Transport } from './schedule';

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let i = 0; from + i * step <= to + 1e-9; i++) out.push(Math.round((from + i * step) * 1000) / 1000);
  return out;
};

// Beats every 0.5 s, a bar line every 2 s (0, 2, 4, …).
const BEATS = range(0, 30, 0.5);
const DOWNBEATS = range(0, 30, 2);
const noLoop = { start: 0, end: 0, on: false };
const playing = (patch: Partial<Transport> = {}): Transport => ({ at: 10, pos: 2, rate: 1, playing: true, ...patch });
const times = (clicks: { time: number }[]) => clicks.map((c) => Math.round(c.time * 1e6) / 1e6);

describe('clicksBetween', () => {
  it('clicks when the song passes each beat', () => {
    const clicks = clicksBetween(playing(), noLoop, BEATS, DOWNBEATS, 10, 11.2);
    expect(times(clicks)).toEqual([10, 10.5, 11]);
    expect(clicks.map((c) => c.accent)).toEqual([true, false, false]);
  });

  it('follows the speed', () => {
    expect(times(clicksBetween(playing({ rate: 0.5 }), noLoop, BEATS, DOWNBEATS, 10, 11.2))).toEqual([10, 11]);
  });

  it('goes round the loop like positionAt', () => {
    const loop = { start: 2, end: 4, on: true };
    const t = playing({ pos: 3.5 });
    const clicks = clicksBetween(t, loop, BEATS, DOWNBEATS, 10, 12);
    expect(times(clicks)).toEqual([10, 10.5, 11, 11.5]);
    // the click after the wrap is beat 2.0, the first of its bar
    expect(clicks.map((c) => c.accent)).toEqual([false, true, false, false]);
    for (const c of clicks) expect(BEATS).toContain(Math.round(positionAt(t, loop, c.time) * 1000) / 1000);
    // many rounds of a long window, still in step with positionAt
    for (const c of clicksBetween(t, loop, BEATS, DOWNBEATS, 10, 40)) {
      const pos = positionAt(t, loop, c.time);
      expect(Math.abs(pos - Math.round(pos * 2) / 2)).toBeLessThan(1e-6);
    }
    expect(clicksBetween(t, loop, BEATS, DOWNBEATS, 10, 40)).toHaveLength(60);
  });

  it('starting past the loop, it jumps into the loop like positionAt', () => {
    const loop = { start: 2, end: 4, on: true };
    const t = playing({ pos: 9 }); // positionAt says 3.0 at once
    expect(times(clicksBetween(t, loop, BEATS, DOWNBEATS, 10, 11.6))).toEqual([10, 10.5, 11, 11.5]);
    expect(positionAt(t, loop, 11)).toBeCloseTo(2, 9);
  });

  it('ignores a loop that is off or too short', () => {
    expect(times(clicksBetween(playing({ pos: 3.5 }), { start: 2, end: 4, on: false }, BEATS, DOWNBEATS, 10, 11.2))).toEqual([10, 10.5, 11]);
    expect(times(clicksBetween(playing({ pos: 3.5 }), { start: 3.5, end: 3.8, on: true }, BEATS, DOWNBEATS, 10, 11.2))).toEqual([10, 10.5, 11]);
  });

  it('is silent on pause and before the song moves', () => {
    expect(clicksBetween(playing({ playing: false }), noLoop, BEATS, DOWNBEATS, 10, 12)).toEqual([]);
    expect(times(clicksBetween(playing({ at: 12 }), noLoop, BEATS, DOWNBEATS, 10, 13.1))).toEqual([12, 12.5, 13]);
  });

  it('gives each click once over back-to-back windows', () => {
    const t = playing({ pos: 2.1, rate: 0.85 });
    const loop = { start: 2, end: 5, on: true };
    const whole = times(clicksBetween(t, loop, BEATS, DOWNBEATS, 10, 30));
    const pieces: number[] = [];
    for (let from = 10; from < 30; from += 0.37) pieces.push(...times(clicksBetween(t, loop, BEATS, DOWNBEATS, from, Math.min(30, from + 0.37))));
    expect(pieces).toEqual(whole);
  });

  it('accents nothing without bar lines', () => {
    expect(clicksBetween(playing(), noLoop, BEATS, [], 10, 12).some((c) => c.accent)).toBe(false);
  });
});

describe('countIn', () => {
  const bars = buildBars(range(0.5, 20, 0.5), range(0.5, 18.5, 2), 0, 21);

  it('counts one bar, then the song starts from the start of the bar', () => {
    const plan = countIn(bars, 3.1, 1, 100);
    expect(plan?.songPos).toBe(2.5);
    expect(times(plan!.clicks)).toEqual([100, 100.5, 101, 101.5]);
    expect(plan!.clicks.map((c) => c.accent)).toEqual([true, false, false, false]);
    expect(plan!.songStartsAt).toBeCloseTo(102, 9);
  });

  it('counts at the playback speed', () => {
    const plan = countIn(bars, 3.1, 0.5, 100);
    expect(times(plan!.clicks)).toEqual([100, 101, 102, 103]);
    expect(plan!.songStartsAt).toBeCloseTo(104, 9);
  });

  it('before the first bar it counts into the first bar', () => {
    expect(countIn(bars, 0.1, 1, 100)?.songPos).toBe(0.5);
  });

  it('from a pickup it counts the rest of the bar, so the downbeat lands on one', () => {
    const withPickup = buildBars(range(0, 20, 0.5), range(0.5, 18.5, 2), 0, 21);
    const plan = countIn(withPickup, 0.2, 1, 100);
    expect(plan?.songPos).toBe(0);
    expect(times(plan!.clicks)).toEqual([100, 100.5, 101]);
    // the pickup beat at 101.5, the first downbeat at 102: one bar after the first click
    expect(plan!.songStartsAt).toBeCloseTo(101.5, 9);
  });

  it('needs bars', () => {
    expect(countIn([], 3, 1, 100)).toBeNull();
  });
});
