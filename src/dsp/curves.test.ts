import { describe, expect, it } from 'vitest';
import { makeDriveCurve, makeSoftClipCurve } from './curves';

function at(curve: Float32Array, x: number): number {
  // WaveShaperNode maps input [-1, 1] linearly onto the curve indices.
  const pos = ((x + 1) / 2) * (curve.length - 1);
  const i = Math.floor(pos);
  const frac = pos - i;
  return curve[i] * (1 - frac) + (curve[Math.min(i + 1, curve.length - 1)] ?? 0) * frac;
}

function isMonotonic(curve: Float32Array): boolean {
  for (let i = 1; i < curve.length; i++) if (curve[i] < curve[i - 1]) return false;
  return true;
}

describe('curves', () => {
  it('soft clip leaves normal levels untouched', () => {
    const c = makeSoftClipCurve();
    expect(at(c, 0.5)).toBeCloseTo(0.5, 2);
    expect(at(c, -0.3)).toBeCloseTo(-0.3, 2);
  });

  it('soft clip never exceeds full scale and stays monotonic', () => {
    const c = makeSoftClipCurve();
    expect(Math.max(...c.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(isMonotonic(c)).toBe(true);
  });

  it('drive curve is bounded, monotonic and passes through zero', () => {
    const c = makeDriveCurve();
    expect(Math.max(...c.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(isMonotonic(c)).toBe(true);
    expect(Math.abs(at(c, 0))).toBeLessThan(0.01);
  });
});
