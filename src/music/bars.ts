// Bars from the analysis' beats and downbeats, the user's bar shift applied; song sections.
import type { Section } from '../song/types';

export interface Bar {
  /** 1, 2, …; a pickup before the first downbeat is bar 0. */
  number: number;
  /** Seconds: from the bar's first beat to the next bar's first beat. */
  start: number;
  end: number;
  /** Times of the bar's beats, the first one = `start`. */
  beats: number[];
}

/** A downbeat counts when a beat is this close to it, seconds. */
const MATCH_WINDOW = 0.05;
/** Beats per bar when the downbeats say nothing. */
const DEFAULT_METER = 4;
/** stepSection: −1 from further into a section than this goes to its start first. */
const RESTART_AFTER = 2;
/** stepSection: +1 from right at a section start goes past it. */
const STEP_EPSILON = 0.05;

/**
 * Bars of the song. Downbeats are matched to beats and moved by `shift` whole beats; bar lines the
 * tracker missed are filled in at the song's usual bar length (also before the first and after the
 * last downbeat), so only a pickup (bar 0) can be shorter. Without downbeats: a bar every four beats.
 * The last bar ends one beat interval after its last beat, but not after `duration`. Fewer than
 * four beats: no bars.
 */
export function buildBars(beats: number[], downbeats: number[], shift: number, duration: number): Bar[] {
  const times = beats.filter(Number.isFinite).sort((a, b) => a - b);
  const n = times.length;
  if (n < 4) return [];
  const matched = matchDownbeats(times, downbeats);
  const meter = usualBarLength(matched);
  const grid = fillGrid(matched.length ? matched : [0], meter, n, Math.abs(Math.round(shift)));
  const starts = grid.map((i) => i + Math.round(shift)).filter((i) => i >= 0 && i < n);

  const bars: Bar[] = [];
  if (!starts.length) return bars;
  if (starts[0] > 0) bars.push(makeBar(0, times, 0, starts[0]));
  starts.forEach((first, k) => bars.push(makeBar(k + 1, times, first, k + 1 < starts.length ? starts[k + 1] : n)));
  const last = bars[bars.length - 1];
  const lastBeat = times[n - 1];
  const after = lastBeat + (lastBeat - times[n - 2]);
  last.end = duration > lastBeat ? Math.min(after, duration) : after;
  return bars;
}

/** Index of the bar `t` is in, −1 before the first bar or from the end of the last. */
export function barAt(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < bars[found].end ? found : -1;
}

/** The nearest bar line (bar starts and the end of the last bar); `t` itself without bars. */
export function snapToBar(bars: Bar[], t: number): number {
  if (!bars.length) return t;
  let best = bars[bars.length - 1].end;
  for (const bar of bars) if (Math.abs(bar.start - t) < Math.abs(best - t)) best = bar.start;
  return best;
}

/** Index of the section `t` is in, −1 when none. */
export function sectionAt(sections: Section[], t: number): number {
  return sections.findIndex((s) => s.start <= t && t < s.end);
}

/**
 * Shift+→ / Shift+←: index of the section to go to, −1 when there is none. Back from more than two
 * seconds into a section goes to its own start first, like a CD player.
 */
export function stepSection(sections: Section[], t: number, dir: 1 | -1): number {
  if (dir > 0) return sections.findIndex((s) => s.start > t + STEP_EPSILON);
  const current = sectionAt(sections, t);
  if (current >= 0) return t - sections[current].start > RESTART_AFTER ? current : Math.max(0, current - 1);
  let before = -1;
  sections.forEach((s, i) => {
    if (s.start < t) before = i;
  });
  return before;
}

/** Indexes of the beats that are downbeats, ascending, each once. */
function matchDownbeats(times: number[], downbeats: number[]): number[] {
  const out = new Set<number>();
  for (const d of downbeats) {
    if (!Number.isFinite(d)) continue;
    const i = nearest(times, d);
    if (Math.abs(times[i] - d) <= MATCH_WINDOW) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** The most common number of beats between downbeats (2–7), else 4. */
function usualBarLength(starts: number[]): number {
  const counts = new Map<number, number>();
  for (let k = 1; k < starts.length; k++) {
    const gap = starts[k] - starts[k - 1];
    if (gap >= 2 && gap <= 7) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = DEFAULT_METER;
  let bestCount = 0;
  for (const [gap, count] of counts) {
    if (count > bestCount || (count === bestCount && gap === DEFAULT_METER)) {
      best = gap;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Bar starts (beat indexes) with the gaps filled every `meter` beats, extended before the first and
 * after the last so that the grid still covers beats 0…n−1 once it is moved by up to `margin`.
 */
function fillGrid(starts: number[], meter: number, n: number, margin: number): number[] {
  const grid: number[] = [];
  starts.forEach((start, k) => {
    grid.push(start);
    if (k + 1 === starts.length) return;
    for (let at = start + meter; starts[k + 1] - at >= meter; at += meter) grid.push(at);
  });
  while (grid[0] > -margin) grid.unshift(grid[0] - meter);
  while (grid[grid.length - 1] < n - 1 + margin) grid.push(grid[grid.length - 1] + meter);
  return grid;
}

function makeBar(number: number, times: number[], first: number, end: number): Bar {
  const beats = times.slice(first, end);
  return { number, start: beats[0], end: times[end] ?? beats[beats.length - 1], beats };
}

/** Index of the time nearest `t` in an ascending list (not empty). */
function nearest(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[hi] - t) < Math.abs(times[lo] - t) ? hi : lo;
}
