// Monophonic pitch detection (McLeod pitch method via pitchy) plus smoothing for display.
import { PitchDetector } from 'pitchy';
import { linToDb, measure } from './level';

export interface PitchResult {
  freq: number;
  clarity: number;
}

export interface PitchOptions {
  minFreq?: number;
  maxFreq?: number;
  minClarity?: number;
  minRmsDb?: number;
}

const detectors = new Map<number, PitchDetector<Float32Array>>();

/** Pitch of a single note in `buf`, or null for silence, noise or chords. */
export function detectPitch(buf: Float32Array, sampleRate: number, options: PitchOptions = {}): PitchResult | null {
  const { minFreq = 60, maxFreq = 1400, minClarity = 0.9, minRmsDb = -55 } = options;
  if (linToDb(measure(buf).rms) < minRmsDb) return null;
  let detector = detectors.get(buf.length);
  if (!detector) {
    detector = PitchDetector.forFloat32Array(buf.length);
    detectors.set(buf.length, detector);
  }
  const [freq, clarity] = detector.findPitch(buf, sampleRate);
  if (!(freq >= minFreq && freq <= maxFreq) || clarity < minClarity) return null;
  return { freq, clarity };
}

/** Median of the last few readings; keeps the note for a moment after the sound stops. */
export class PitchSmoother {
  private history: number[] = [];
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly size = 5,
    private readonly holdMs = 400,
  ) {}

  push(result: PitchResult | null, nowMs: number): number | null {
    if (result) {
      this.history.push(result.freq);
      if (this.history.length > this.size) this.history.shift();
      this.lastAt = nowMs;
    } else if (nowMs - this.lastAt > this.holdMs) {
      this.history = [];
    }
    if (!this.history.length) return null;
    const sorted = [...this.history].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  reset(): void {
    this.history = [];
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}
