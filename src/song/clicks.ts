// Clicks on the song's own beats and the count-in, as context times. Pure: the player schedules
// what these return. The song position follows `positionAt` exactly, loop wrap included.
import { barAt, type Bar } from '../music/bars';
import { loopActive, type Transport } from './schedule';
import type { Loop } from './types';

export interface Click {
  /** Context time (the song's AudioContext). */
  time: number;
  /** The first beat of a bar. */
  accent: boolean;
}

/** A beat counts as a bar line when a downbeat is this close, seconds. */
const ACCENT_WINDOW = 0.05;
/** Seconds of song time added round the window before the exact test on context times. */
const SLACK = 1e-6;

/**
 * Clicks with context times in [from, to) for every beat the song passes, wrapping round an active
 * loop the way `positionAt` does. Back-to-back windows give each click exactly once. Paused: none.
 * `downbeats` are the bar starts to accent (with the user's bar shift: the bars' starts, no pickup).
 */
export function clicksBetween(t: Transport, loop: Loop, beats: number[], downbeats: number[], from: number, to: number): Click[] {
  if (!t.playing || !(t.rate > 0) || !(to > from) || !beats.length) return [];
  const start = Math.max(from, t.at);
  if (start >= to) return [];
  // Unwrapped song time (how far the song has moved since `t.at`, as if there were no loop), a little
  // wider than the window: the window itself is applied to the context times only, so that
  // back-to-back windows split the clicks exactly, without rounding dropping or doubling one.
  const lo = t.pos + (start - t.at) * t.rate - SLACK;
  const hi = t.pos + (to - t.at) * t.rate + SLACK;
  const sortedDown = [...downbeats].sort((a, b) => a - b);
  const clicks: Click[] = [];
  const add = (unwrapped: number, beat: number) => {
    const time = t.at + (unwrapped - t.pos) / t.rate;
    if (time >= start && time < to) clicks.push({ time, accent: near(sortedDown, beat) });
  };

  if (!loopActive(loop)) {
    for (const beat of beatsIn(beats, lo, hi)) add(beat, beat);
    return clicks;
  }
  const length = loop.end - loop.start;
  // Before the loop end the song plays straight on (positionAt only wraps from loop.end).
  if (t.pos < loop.end) for (const beat of beatsIn(beats, lo, Math.min(hi, loop.end))) add(beat, beat);
  // From loop.end on, round k plays loop.start…loop.end at unwrapped loop.end + k·length.
  const inLoop = beatsIn(beats, loop.start, loop.end);
  if (!inLoop.length) return clicks.sort((a, b) => a.time - b.time);
  const firstRound = Math.max(0, Math.floor((lo - loop.end) / length) - 1);
  for (let k = firstRound; loop.end + k * length < hi; k++) {
    for (const beat of inLoop) add(loop.end + k * length + (beat - loop.start), beat);
  }
  return clicks.sort((a, b) => a.time - b.time);
}

/**
 * «Отсчёт»: a bar of clicks from `startAt` (context time), then the song from the start of the bar
 * `pos` is in. Before the first bar it counts into the first bar. From a pickup (bar 0) it counts
 * only the beats the pickup lacks, so the first downbeat still comes one bar after the first click.
 * Null without bars.
 */
export function countIn(
  bars: Bar[],
  pos: number,
  rate: number,
  startAt: number,
): { clicks: Click[]; songPos: number; songStartsAt: number } | null {
  if (!bars.length || !(rate > 0)) return null;
  let index = barAt(bars, pos);
  if (index < 0) index = pos < bars[0].start ? 0 : bars.length - 1;
  const bar = bars[index];
  const full = bar.number === 0 && bars.length > 1 ? bars[index + 1] : bar;
  const interval = (full.end - full.start) / Math.max(1, full.beats.length);
  const count = bar === full ? full.beats.length : Math.max(1, full.beats.length - bar.beats.length);
  const step = interval / rate;
  const clicks = Array.from({ length: count }, (_, i) => ({ time: startAt + i * step, accent: i === 0 }));
  return { clicks, songPos: bar.start, songStartsAt: startAt + count * step };
}

/** Beats in [lo, hi), ascending. */
function beatsIn(beats: number[], lo: number, hi: number): number[] {
  return beats.filter((beat) => beat >= lo && beat < hi).sort((a, b) => a - b);
}

/** Whether a sorted list has a value within ACCENT_WINDOW of `x`. */
function near(sorted: number[], x: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Math.abs(sorted[mid] - x) <= ACCENT_WINDOW) return true;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
