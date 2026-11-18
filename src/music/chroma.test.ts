import { describe, expect, it } from 'vitest';
import { chordMatch, chromaFromSpectrum, judgeChord } from './chroma';

const RATE = 48000;
const BINS = 4096; // an AnalyserNode with fftSize 8192
const BIN_HZ = RATE / (2 * BINS);
const midiHz = (midi: number, a4 = 440) => a4 * 2 ** ((midi - 69) / 12);

/** A spectrum in dB as getFloatFrequencyData gives it: harmonics 1–5 of each note as smooth peaks. */
function spectrum(notes: number[], { peakDb = -20, floorDb = -100, a4 = 440 } = {}): Float32Array {
  const db = new Float32Array(BINS).fill(floorDb);
  for (const note of notes) {
    for (let h = 1; h <= 5; h++) {
      const at = (midiHz(note, a4) * h) / BIN_HZ;
      for (let k = Math.floor(at) - 2; k <= Math.ceil(at) + 2; k++) {
        if (k < 0 || k >= BINS) continue;
        db[k] = Math.max(db[k], peakDb - 12 * (k - at) ** 2);
      }
    }
  }
  return db;
}

const C3 = 48;
const E3 = 52;
const G3 = 55;
const C_MAJOR = spectrum([C3, E3, G3]);

describe('chromaFromSpectrum', () => {
  it('finds the notes of a C major chord, root strongest', () => {
    const chroma = chromaFromSpectrum(C_MAJOR, RATE);
    expect(chroma).not.toBeNull();
    const c = chroma!;
    expect(c[0]).toBe(1);
    expect(Math.max(...c)).toBe(1);
    expect(c[4]).toBeGreaterThan(0.4);
    expect(c[7]).toBeGreaterThan(0.4);
    expect(c[1]).toBeLessThan(0.2);
    expect(c[6]).toBeLessThan(0.2);
  });

  it('follows the tuner calibration', () => {
    const a432 = chromaFromSpectrum(spectrum([57], { a4: 432 }), RATE, 432)!;
    expect(a432.indexOf(1)).toBe(9);
  });

  it('gives null for silence', () => {
    expect(chromaFromSpectrum(new Float32Array(BINS).fill(-100), RATE)).toBeNull();
    expect(chromaFromSpectrum(new Float32Array(BINS).fill(-Infinity), RATE)).toBeNull();
    expect(chromaFromSpectrum(spectrum([C3], { peakDb: -75 }), RATE)).toBeNull();
  });
});

describe('judgeChord', () => {
  const chroma = chromaFromSpectrum(C_MAJOR, RATE);

  it('matches the chord played, is close to one sharing notes, misses one without them', () => {
    expect(judgeChord(chroma, { root: 0, quality: 'maj' })).toBe('match');
    expect(judgeChord(chroma, { root: 9, quality: 'min' })).toBe('close');
    expect(judgeChord(chroma, { root: 6, quality: 'maj' })).toBe('miss');
  });

  it('is silent without sound or without a chord to check', () => {
    expect(judgeChord(chromaFromSpectrum(new Float32Array(BINS).fill(-100), RATE), { root: 0, quality: 'maj' })).toBe('silent');
    expect(judgeChord(chroma, null)).toBe('silent');
  });

  it('scores 0–1, highest for the chord played', () => {
    const c = chroma!;
    const scores = [0, 2, 4, 5, 7, 9, 11].map((root) => chordMatch(c, { root, quality: 'maj' }));
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...scores)).toBe(scores[0]);
  });
});
