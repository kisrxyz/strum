import { describe, expect, it } from 'vitest';
import { MIN_DB, MeterBallistics, dbToLin, levelZone, linToDb, measure } from './level';

describe('level', () => {
  it('converts between linear and dB', () => {
    expect(linToDb(1)).toBe(0);
    expect(linToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(linToDb(0)).toBe(MIN_DB);
    expect(dbToLin(-20)).toBeCloseTo(0.1, 6);
  });

  it('measures peak and RMS', () => {
    const { peak, rms } = measure(Float32Array.from([0.5, -1, 0.5, 0]));
    expect(peak).toBe(1);
    expect(rms).toBeCloseTo(Math.sqrt(1.5 / 4), 6);
  });

  it('classifies input level zones', () => {
    expect(levelZone(-70)).toBe('silent');
    expect(levelZone(-40)).toBe('low');
    expect(levelZone(-12)).toBe('good');
    expect(levelZone(-3)).toBe('hot');
    expect(levelZone(0)).toBe('clip');
  });

  it('judges the level the amps get, but the overload and the silence by the card', () => {
    // A quiet card, trimmed up 16 dB: good. Trimmed too far: hot, not an overload.
    expect(levelZone(-9, -25)).toBe('good');
    expect(levelZone(1, -15)).toBe('hot');
    // The card itself overloads, whatever the trim does after it.
    expect(levelZone(-12, -0.2)).toBe('clip');
    // No input stays «silent» even with the trim up.
    expect(levelZone(-46, -70)).toBe('silent');
  });

  it('calls a strum that plays but is too quiet for the amps «soft»', () => {
    // The presets are levelled for a strum at −9 dBFS: −16 … −6 is good, −30 … −16 plays but soft.
    expect(levelZone(-9)).toBe('good');
    expect(levelZone(-16)).toBe('good');
    expect(levelZone(-16.5)).toBe('soft');
    expect(levelZone(-29)).toBe('soft');
    expect(levelZone(-30.5)).toBe('low');
    expect(levelZone(-6)).toBe('good');
    expect(levelZone(-5.5)).toBe('hot');
  });

  it('rises instantly, falls slowly and holds the peak', () => {
    const m = new MeterBallistics();
    expect(m.update(-10, 1000).levelDb).toBe(-10);
    const later = m.update(-60, 2000);
    expect(later.levelDb).toBeCloseTo(-34, 5); // 24 dB/s fall
    expect(later.holdDb).toBe(-10); // held for 1.5 s
    expect(m.update(-60, 2600).holdDb).toBeLessThan(-10); // hold expired
  });
});
