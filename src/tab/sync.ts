// Tying a tab's bars to the recording's bars. The tab is played in its own order (repeats and
// endings unrolled); each of its bars starts on a bar line of the recording: tab bar i on recording
// bar `offset + i·ratio`. `ratio` covers a tempo the beat tracker counted twice (or half) as fast.
import type { Bar } from '../music/bars';
import { chordAt } from '../music/track';
import { parseChord } from '../music/chords';
import type { ChordSegment } from '../song/types';

/** A bar of the tab in playback order. */
export interface TabBar {
  /** The master bar's index in the score. */
  index: number;
  /** How many times this master bar was played before (0 the first time). */
  occurrence: number;
  /** Seconds from the tab's start at its own tempo. */
  start: number;
  seconds: number;
  /** Pitch classes of the lowest note of each beat of the chosen part (for matching chords). */
  roots: number[];
}

export type TabRatio = 0.5 | 1 | 2;

export interface TabSync {
  /** The recording bar (index into the song's bars) the tab's first bar starts on. */
  offset: number;
  /** Recording bars per tab bar. */
  ratio: TabRatio;
}

export interface SyncTime {
  index: number;
  occurrence: number;
  /** Seconds in the recording. */
  time: number;
}

const RATIOS: TabRatio[] = [0.5, 1, 2];
const MAX_OFFSET = 32;
const MATCH_BARS = 16;

/** The most common value (the lowest on a tie); null for an empty list. */
function mode(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  for (const [v, n] of counts) if (best === null || n > counts.get(best)! || (n === counts.get(best)! && v < best)) best = v;
  return best;
}

/** The ratio that makes the tab's tempo fit the recording's (1 when none fits within 15 %). */
export function tempoRatio(tabTempo: number, songTempo: number): TabRatio {
  if (!(tabTempo > 0) || !(songTempo > 0)) return 1;
  const r = songTempo / tabTempo;
  const best = RATIOS.reduce((a, b) => (Math.abs(Math.log(r / b)) < Math.abs(Math.log(r / a)) ? b : a));
  return Math.abs(r / best - 1) <= 0.15 ? best : 1;
}

/** Guesses where the tab starts in the recording and at which bar ratio. */
export function autoSync(tab: TabBar[], bars: Bar[], track: ChordSegment[], tabTempo: number, songTempo: number): TabSync {
  const ratio = tempoRatio(tabTempo, songTempo);
  if (!bars.length) return { offset: 0, ratio };
  const rootAt = (t: number): number | null => {
    const i = chordAt(track, t);
    const chord = i >= 0 ? parseChord(track[i].chord) : null;
    return chord ? chord.root : null;
  };
  const tabRoots = tab.slice(0, MATCH_BARS).map((bar) => mode(bar.roots));
  let best = { offset: -1, share: 0 };
  for (let offset = 0; offset <= Math.min(MAX_OFFSET, bars.length - 1); offset++) {
    let hits = 0;
    let counted = 0;
    tabRoots.forEach((root, i) => {
      const j = offset + Math.floor(i * ratio);
      if (root === null || j >= bars.length) return;
      counted++;
      const heard = rootAt((bars[j].start + bars[j].end) / 2);
      if (heard === root) hits++;
    });
    const share = counted ? hits / counted : 0;
    if (share > best.share) best = { offset, share };
  }
  if (best.offset >= 0) return { offset: best.offset, ratio };
  // Nothing to match by: the first bar where the recording has a chord.
  const first = bars.findIndex((bar) => rootAt((bar.start + bar.end) / 2) !== null);
  return { offset: Math.max(0, first), ratio };
}

/** Recording time of every tab bar's start: strictly increasing, extrapolated past either end. */
export function syncTimes(tab: TabBar[], bars: Bar[], sync: TabSync): SyncTime[] {
  if (!bars.length) {
    return tab.map((bar) => ({ index: bar.index, occurrence: bar.occurrence, time: bar.start }));
  }
  const n = bars.length;
  const firstLen = bars[0].end - bars[0].start;
  const lastLen = bars[n - 1].end - bars[n - 1].start;
  const lineAt = (k: number) => (k < n ? bars[k].start : bars[n - 1].end);
  const timeAt = (p: number): number => {
    if (p < 0) return bars[0].start + p * firstLen;
    if (p >= n) return bars[n - 1].end + (p - n) * lastLen;
    const k = Math.floor(p);
    return lineAt(k) + (p - k) * (lineAt(k + 1) - lineAt(k));
  };
  let previous = -Infinity;
  return tab.map((bar, i) => {
    let time = Math.max(0, timeAt(sync.offset + i * sync.ratio));
    if (time <= previous) time = previous + 0.001; // bars before the recording's start
    previous = time;
    return { index: bar.index, occurrence: bar.occurrence, time };
  });
}

/** «;» / Shift+«;»: the tab one bar later (+1) or earlier (−1) against the recording. */
export function nudgeSync(sync: TabSync, dir: 1 | -1): TabSync {
  return { ...sync, offset: sync.offset + dir * Math.max(1, sync.ratio) };
}
