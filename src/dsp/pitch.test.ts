import { describe, expect, it } from 'vitest';
import { PitchSmoother, detectPitch } from './pitch';

const SR = 48000;
const N = 4096;

function tone(freq: number, harmonics: number[], amp = 0.3): Float32Array {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    harmonics.forEach((a, k) => {
      v += a * Math.sin((2 * Math.PI * freq * (k + 1) * i) / SR + k);
    });
    buf[i] = amp * v;
  }
  return buf;
}

describe('detectPitch', () => {
  it('finds a pure low E', () => {
    const r = detectPitch(tone(82.41, [1]), SR);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.freq - 82.41) / 82.41).toBeLessThan(0.005);
  });

  it('finds the fundamental of a guitar-like tone with a weak fundamental', () => {
    // Harmonics 1..8 with amplitude 1/k, fundamental reduced to 0.3.
    const harmonics = [0.3, ...Array.from({ length: 7 }, (_, k) => 1 / (k + 2))];
    const r = detectPitch(tone(110, harmonics, 0.15), SR);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.freq - 110) / 110).toBeLessThan(0.01);
  });

  it('ignores silence', () => {
    expect(detectPitch(new Float32Array(N), SR)).toBeNull();
  });

  it('ignores white noise', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const noise = Float32Array.from({ length: N }, () => 0.3 * rand());
    expect(detectPitch(noise, SR)).toBeNull();
  });
});

describe('PitchSmoother', () => {
  it('drops a single outlier', () => {
    const s = new PitchSmoother();
    const readings = [110, 110, 220, 110, 110];
    let out: number | null = null;
    readings.forEach((freq, i) => {
      out = s.push({ freq, clarity: 0.95 }, i * 16);
      if (i >= 2) expect(out).toBe(110);
    });
    expect(out).toBe(110);
  });

  it('holds the last note briefly, then lets go', () => {
    const s = new PitchSmoother();
    s.push({ freq: 196, clarity: 0.95 }, 0);
    expect(s.push(null, 300)).toBe(196);
    expect(s.push(null, 401)).toBeNull();
  });
});
