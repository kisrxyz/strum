// A text's chords are sometimes written in another key than the recording (a simpler key, or for
// another singer). The roots of the text's chords are compared with the roots the analysis heard:
// the shift that makes them agree best, when it is clearly better than none.
import { parseChord } from '../music/chords';
import type { ChordSegment } from '../song/types';
import type { LyricDoc } from './parse';

/** The shift has to agree with at least this share of the chords… */
const MIN_AGREEMENT = 0.5;
/** …and beat no shift by this factor. */
const MIN_GAIN = 1.25;

function normalised(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  return sum > 0 ? weights.map((w) => w / sum) : weights;
}

/**
 * Semitones (−5…6) to move the doc's chords by so their roots match the chord track's. 0 when the
 * text or the track has no chords, or no shift is clearly better. Apply the text's capo first.
 */
export function textShift(doc: LyricDoc, track: ChordSegment[]): number {
  const text = new Array<number>(12).fill(0);
  for (const line of doc.lines) {
    for (const c of line.chords) {
      const chord = parseChord(c.label);
      if (chord) text[chord.root] += 1;
    }
  }
  const heard = new Array<number>(12).fill(0);
  for (const seg of track) {
    const chord = parseChord(seg.chord);
    if (chord) heard[chord.root] += Math.max(0, seg.end - seg.start);
  }
  const t = normalised(text);
  const h = normalised(heard);
  if (!t.some(Boolean) || !h.some(Boolean)) return 0;
  // How well the shifted roots fit the heard ones (both weighted), and the share of the text's
  // chords whose shifted root was heard at all (at least 5 % of the time).
  const score = (shift: number) => t.reduce((sum, w, r) => sum + w * h[(r + shift) % 12], 0);
  const agreement = (shift: number) => t.reduce((sum, w, r) => sum + (h[(r + shift) % 12] >= 0.05 ? w : 0), 0);
  let best = 0;
  for (let s = 1; s < 12; s++) if (score(s) > score(best)) best = s;
  if (best === 0 || agreement(best) < MIN_AGREEMENT || score(best) < MIN_GAIN * score(0)) return 0;
  return best > 6 ? best - 12 : best;
}
