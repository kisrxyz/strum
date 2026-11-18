import { describe, expect, it } from 'vitest';
import { TRIM_LISTEN_MS, TRIM_MAX_DB, TRIM_MIN_DB, TRIM_TARGET_DB, TRIM_WAIT_MS, TrimListener, cleanTrim, trimFor } from './inputTrim';

describe('trimFor', () => {
  it('brings the hardest strum to the level the amps were levelled for', () => {
    expect(trimFor(-25)).toEqual({ verdict: 'ok', trimDb: 16, peakDb: -25 });
    expect(trimFor(TRIM_TARGET_DB)).toEqual({ verdict: 'ok', trimDb: 0, peakDb: TRIM_TARGET_DB });
    expect(trimFor(-4)).toEqual({ verdict: 'ok', trimDb: -5, peakDb: -4 });
    expect(trimFor(-17.3).trimDb).toBe(8.5); // half decibels
  });

  it('says when the card itself overloads, and turns down as far as it can tell', () => {
    expect(trimFor(-0.2)).toEqual({ verdict: 'clip', trimDb: -9, peakDb: -0.2 });
  });

  it('says when even the most it gives is not enough', () => {
    expect(trimFor(-45)).toEqual({ verdict: 'weak', trimDb: TRIM_MAX_DB, peakDb: -45 });
  });

  it('changes nothing when it heard nothing', () => {
    expect(trimFor(-70)).toEqual({ verdict: 'silent', trimDb: null, peakDb: -70 });
    expect(trimFor(Number.NEGATIVE_INFINITY).verdict).toBe('silent');
  });

  it('keeps a trim inside its range, in half decibels', () => {
    expect(cleanTrim(30)).toBe(TRIM_MAX_DB);
    expect(cleanTrim(-40)).toBe(TRIM_MIN_DB);
    expect(cleanTrim(3.26)).toBe(3.5);
    expect(cleanTrim(Number.NaN)).toBe(0);
  });
});

describe('TrimListener', () => {
  /** Frames every 16 ms: `strums` hard strums (peaks at `peakDb`) that ring down 20 dB, then rest. */
  function play(listener: TrimListener, from: number, peakDb: number, strums: number, gapMs = 900) {
    let now = from;
    for (let s = 0; s < strums; s++) {
      for (let t = 0; t < gapMs; t += 16) {
        const result = listener.push(peakDb - (20 * t) / gapMs, now);
        if (result) return { result, now };
        now += 16;
      }
    }
    return { result: null, now };
  }

  it('takes the hardest strum over the listening time and counts the strums', () => {
    const listener = new TrimListener(0);
    expect(listener.push(-80, 0)).toBeNull(); // nothing yet: waiting
    const { result: early } = play(listener, 100, -26, 3);
    expect(early).toBeNull(); // 2.7 s: still listening
    expect(listener.heard).toBe(3);
    expect(listener.progress(100 + 2700)).toBeCloseTo(2700 / TRIM_LISTEN_MS, 1);
    const { result } = play(listener, 2800, -22, 10);
    expect(result).toEqual({ verdict: 'ok', trimDb: 13, peakDb: -22 });
  });

  it('gives up on silence after the waiting time', () => {
    const listener = new TrimListener(0);
    let result = null;
    for (let now = 0; !result; now += 16) result = listener.push(-75, now);
    expect(result.verdict).toBe('silent');
    expect(listener.progress(TRIM_WAIT_MS)).toBe(0);
  });

  it('starts listening at the first strum, not at the press', () => {
    const listener = new TrimListener(0);
    for (let now = 0; now < 6000; now += 16) expect(listener.push(-80, now)).toBeNull();
    const { result, now } = play(listener, 6000, -12, 20);
    expect(result?.trimDb).toBe(3);
    expect(now - 6000).toBeGreaterThanOrEqual(TRIM_LISTEN_MS - 16);
  });
});
