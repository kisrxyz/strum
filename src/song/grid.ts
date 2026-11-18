// The open song's bar grid: the analysis' beats with the bar lines moved by the user's shift.
import { buildBars, type Bar } from '../music/bars';
import type { BeatGrid } from './player';
import type { Analysis, Song } from './types';

let memo: { analysis: Analysis; shift: number; duration: number; bars: Bar[] } | null = null;

/** Bars of the song ([] without an analysis or without usable beats). Cached for the last song. */
export function songBars(song: Song | null, analysis: Analysis | null): Bar[] {
  if (!song || !analysis) return [];
  if (memo && memo.analysis === analysis && memo.shift === song.barShift && memo.duration === song.duration) {
    return memo.bars;
  }
  const bars = buildBars(analysis.beats, analysis.downbeats, song.barShift, song.duration);
  memo = { analysis, shift: song.barShift, duration: song.duration, bars };
  return bars;
}

/** What the player needs for clicks and the count-in; null when there are no bars. */
export function beatGrid(song: Song | null, analysis: Analysis | null): BeatGrid | null {
  const bars = songBars(song, analysis);
  if (!analysis || !bars.length) return null;
  // A pickup (bar 0) is not the first beat of a bar: no accent there.
  const downbeats = bars.filter((bar) => bar.number > 0).map((bar) => bar.start);
  return { beats: analysis.beats, downbeats, bars };
}

/** Cents that bring the recording to the tuner's A (the guitar is tuned to it). */
export function centsToMatch(tuningCents: number, a4: number): number {
  const target = 1200 * Math.log2(a4 / 440);
  return Math.max(-50, Math.min(50, Math.round(target - tuningCents)));
}
