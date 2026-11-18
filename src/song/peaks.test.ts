import { describe, expect, it } from 'vitest';
import { peakColumns } from './peaks';

const track = (bins: number, value = 64) => {
  const peaks = new Int8Array(bins * 2);
  for (let i = 0; i < bins; i++) {
    peaks[2 * i] = -value;
    peaks[2 * i + 1] = value;
  }
  return peaks;
};

describe('peakColumns', () => {
  it('maps a constant track to constant columns in -1..1', () => {
    const columns = peakColumns(track(300), 100, 40, 3);
    expect(columns.length).toBe(80);
    for (let c = 0; c < 40; c++) {
      expect(columns[2 * c]).toBeCloseTo(-0.504, 3);
      expect(columns[2 * c + 1]).toBeCloseTo(0.504, 3);
    }
  });

  it('puts a spike into the column that covers its time', () => {
    const peaks = track(100, 0);
    peaks[2 * 55] = -127;
    peaks[2 * 55 + 1] = 127;
    const columns = peakColumns(peaks, 100, 10, 1);
    expect(Array.from(columns.subarray(10, 12))).toEqual([-1, 1]);
    expect(Array.from(columns.subarray(8, 10))).toEqual([0, 0]);
    expect(Array.from(columns.subarray(12, 14))).toEqual([0, 0]);
  });

  it('gives every column at least one bin when zoomed in far', () => {
    const columns = peakColumns(track(10), 100, 50, 0.1);
    expect(columns.every((v, i) => (i % 2 ? v > 0 : v < 0))).toBe(true);
  });
});
