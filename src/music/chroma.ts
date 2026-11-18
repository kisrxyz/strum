// «Проверь меня»: which notes the guitar plays (a 12-note chroma from the analyser's spectrum) and
// how well they fit the chord that sounds in the song.
import { chordTones, pitchClass, type Chord } from './chords';

export type Judgement = 'match' | 'close' | 'miss' | 'silent';

const LOW_HZ = 80;
const HIGH_HZ = 2000;
/** Quieter than this in the guitar's range: nothing is played. */
const SILENT_DB = -70;
/** Peaks this far below the loudest one are left out (noise, side lobes). */
const PEAK_RANGE_DB = 40;
/** chordMatch from here on: the chord played. */
const MATCH = 0.8;
/** chordMatch from here on: it shares notes with the chord. */
const CLOSE = 0.55;

/**
 * Pitch-class weights 0–1 (the strongest = 1) of the peaks between 80 and 2000 Hz.
 * `db` = AnalyserNode.getFloatFrequencyData with fftSize = 2·db.length. Each peak's frequency is
 * interpolated; its weight is its amplitude divided by its frequency, so fundamentals count more
 * than their overtones. Null when the loudest bin there is below −70 dB.
 */
export function chromaFromSpectrum(db: Float32Array, sampleRate: number, a4 = 440): Float32Array | null {
  if (db.length < 3 || !(sampleRate > 0)) return null;
  const binHz = sampleRate / (2 * db.length);
  const first = Math.max(1, Math.ceil(LOW_HZ / binHz));
  const last = Math.min(db.length - 2, Math.floor(HIGH_HZ / binHz));
  let loudest = -Infinity;
  for (let k = first; k <= last; k++) if (db[k] > loudest) loudest = db[k];
  if (!(loudest >= SILENT_DB)) return null;

  const chroma = new Float32Array(12);
  const floor = loudest - PEAK_RANGE_DB;
  for (let k = first; k <= last; k++) {
    const level = db[k];
    if (!(level >= floor) || !(level > db[k - 1]) || !(level >= db[k + 1])) continue;
    const freq = (k + peakOffset(db[k - 1], level, db[k + 1])) * binHz;
    if (freq < LOW_HZ || freq > HIGH_HZ) continue;
    const pc = pitchClass(Math.round(69 + 12 * Math.log2(freq / a4)));
    chroma[pc] += 10 ** (level / 20) / freq;
  }
  let max = 0;
  for (const weight of chroma) max = Math.max(max, weight);
  if (!(max > 0)) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= max;
  return chroma;
}

/** How well the notes fit the chord, 0–1: cosine similarity with the chord's notes. */
export function chordMatch(chroma: Float32Array, chord: Chord): number {
  const tones = chordTones(chord);
  let energy = 0;
  for (const weight of chroma) energy += weight * weight;
  if (!(energy > 0)) return 0;
  let inChord = 0;
  for (const pc of tones) inChord += chroma[pc];
  return Math.min(1, inChord / (Math.sqrt(energy) * Math.sqrt(tones.length)));
}

/**
 * warm «match», neutral «close», cold «miss». «silent» when nothing is played, and when there is no
 * chord to check against (N, X).
 */
export function judgeChord(chroma: Float32Array | null, expected: Chord | null): Judgement {
  if (!chroma || !expected) return 'silent';
  const fit = chordMatch(chroma, expected);
  return fit >= MATCH ? 'match' : fit >= CLOSE ? 'close' : 'miss';
}

/** Where between bins the top of a peak is (−0.5…0.5), from a parabola through three dB values. */
function peakOffset(left: number, mid: number, right: number): number {
  const curve = left - 2 * mid + right;
  const offset = curve < 0 ? (0.5 * (left - right)) / curve : 0;
  return Number.isFinite(offset) ? Math.max(-0.5, Math.min(0.5, offset)) : 0;
}
