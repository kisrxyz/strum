// The song's chord track: which chord is when, the user's edits, and how much of it is shown.
import type { Analysis, ChordLabel, ChordSegment, RevealLevel, Song, SongMode } from '../song/types';

/** What of the chords is visible (decision 12: «Играть» shows everything, «Снять на слух» opens step by step). */
export interface Visible {
  /** The moments the chord changes. */
  changes: boolean;
  /** The name of the chord that sounds now (and its notes on the fretboard). */
  currentName: boolean;
  /** Every chord of the lane. */
  allNames: boolean;
  /** Chord boxes and the chosen fingering on the fretboard. */
  fingerings: boolean;
}

/** A piece split off shorter than this is not made. */
const MIN_PIECE = 0.01;

/** The user's chords when there are any, else the analysis' ones. */
export function effectiveChords(song: Song, analysis: Analysis | null): ChordSegment[] {
  return song.chords ?? analysis?.chords ?? [];
}

/** Index of the chord sounding at `t`, −1 outside the track. */
export function chordAt(track: ChordSegment[], t: number): number {
  let lo = 0;
  let hi = track.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < track[found].end ? found : -1;
}

/** When the chord changes next after `t` (seconds), null when it does not. */
export function nextChange(track: ChordSegment[], t: number): number | null {
  const current = chordAt(track, t);
  const label: ChordLabel | null = current >= 0 ? track[current].chord : null;
  for (let i = current >= 0 ? current + 1 : 0; i < track.length; i++) {
    if (track[i].start > t && track[i].chord !== label) return track[i].start;
  }
  return null;
}

/** The chord at `index` (of the track as given) set to `label`; equal neighbours merge. */
export function setChord(track: ChordSegment[], index: number, label: ChordLabel): ChordSegment[] {
  const next = track.map((seg, i) => (i === index ? { ...seg, chord: label } : seg));
  return normalise(next, true);
}

/**
 * The chord at `t` cut in two at the beat nearest `t` inside it (at `t` itself without such a beat).
 * Both halves keep the chord and stay apart, so the next setChord can change one of them.
 */
export function splitAt(track: ChordSegment[], t: number, beats: number[]): ChordSegment[] {
  const list = normalise(track, false);
  const index = chordAt(list, t);
  if (index < 0) return list;
  const seg = list[index];
  const inside = (x: number) => x - seg.start >= MIN_PIECE && seg.end - x >= MIN_PIECE;
  let cut: number | null = inside(t) ? t : null;
  let best = Infinity;
  for (const beat of beats) {
    if (inside(beat) && Math.abs(beat - t) < best) {
      best = Math.abs(beat - t);
      cut = beat;
    }
  }
  if (cut === null) return list;
  return [...list.slice(0, index), { ...seg, end: cut }, { ...seg, start: cut }, ...list.slice(index + 1)];
}

/** The chord at `index` (of the track as given) becomes part of the one before it. */
export function mergeWithPrevious(track: ChordSegment[], index: number): ChordSegment[] {
  if (index <= 0 || index >= track.length) return normalise(track, true);
  const prev = track[index - 1];
  const merged = { ...prev, end: Math.max(prev.end, track[index].end) };
  return normalise([...track.slice(0, index - 1), merged, ...track.slice(index + 1)], true);
}

export function visibility(mode: SongMode, reveal: RevealLevel): Visible {
  const level = mode === 'play' ? 3 : reveal;
  return { changes: level >= 1, currentName: level >= 2, allNames: level >= 3, fingerings: level >= 3 };
}

/** Sorted, without gaps or overlaps (a gap goes to the chord before it), empty pieces dropped. */
function normalise(track: ChordSegment[], mergeEqual: boolean): ChordSegment[] {
  const sorted = track
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .map((seg) => ({ ...seg }))
    .sort((a, b) => a.start - b.start);
  const out: ChordSegment[] = [];
  for (const seg of sorted) {
    let prev = out[out.length - 1];
    if (prev && seg.start - prev.start < MIN_PIECE) {
      out.pop();
      prev = out[out.length - 1];
    }
    if (prev) prev.end = seg.start;
    if (prev && mergeEqual && prev.chord === seg.chord) {
      prev.end = seg.end;
      continue;
    }
    out.push(seg);
  }
  return out;
}
