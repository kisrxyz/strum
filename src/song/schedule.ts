// Where the song is: the player keeps its own copy of what it told the stretch worklet, so the
// position is computed here instead of read back from the audio thread.
import type { Bookmark, Loop } from './types';

/** Shortest loop that counts, seconds. */
export const MIN_LOOP = 0.5;
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1;
export const SEMITONES_MAX = 2;
export const CENTS_MAX = 50;
/** A marked at exactly 0 s is stored as this, so "only A is set" stays different from "nothing". */
const A_AT_START = 0.001;

/** One stretch of playback: from context time `at` the song is at `pos` and moves at `rate`. */
export interface Transport {
  at: number;
  pos: number;
  rate: number;
  playing: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mod = (x: number, m: number) => ((x % m) + m) % m;

export function loopActive(loop: Loop): boolean {
  return loop.on && loop.end - loop.start >= MIN_LOOP;
}

/** Song time at context time `now`. Past the end of an active loop it wraps, as the worklet does. */
export function positionAt(t: Transport, loop: Loop, now: number): number {
  const pos = t.playing ? t.pos + Math.max(0, now - t.at) * t.rate : t.pos;
  if (!loopActive(loop) || pos < loop.end) return pos;
  return loop.start + mod(pos - loop.start, loop.end - loop.start);
}

/** How the song moves at one moment: where it is, how fast, and where the straight run ends. */
export interface Motion {
  pos: number;
  /** Song seconds per second; 0 while standing (paused, a count-in before the start, the end). */
  rate: number;
  /** Song time where it stops or jumps: the end of the active loop or of the song. */
  until: number;
}

/** The song's motion at context time `now` (the moving lane glides by it between transport changes). */
export function motionAt(t: Transport, loop: Loop, now: number, duration: number): Motion {
  const pos = clamp(positionAt(t, loop, now), 0, duration);
  const until = loopActive(loop) && pos < loop.end ? Math.min(loop.end, duration) : duration;
  const moving = t.playing && now >= t.at && until > pos;
  return { pos, rate: moving ? t.rate : 0, until: moving ? until : pos };
}

/** ← / →: inside an active loop the jump goes round the loop, elsewhere it stops at the edges. */
export function seekBy(pos: number, delta: number, loop: Loop, duration: number): number {
  if (loopActive(loop) && pos >= loop.start && pos < loop.end) {
    return loop.start + mod(pos + delta - loop.start, loop.end - loop.start);
  }
  return clamp(pos + delta, 0, duration);
}

/** A: the loop starts here. An existing end after it stays; otherwise only A is set. */
export function markA(loop: Loop, pos: number, duration: number): Loop {
  const start = clamp(Math.max(pos, A_AT_START), 0, duration);
  return loop.end - start >= MIN_LOOP ? { start, end: loop.end, on: loop.on } : { start, end: 0, on: false };
}

/** B: the loop ends here and turns on. Null when there is no A at least MIN_LOOP before. */
export function markB(loop: Loop, pos: number): Loop | null {
  const hasStart = loop.start > 0 || loop.end > 0;
  if (!hasStart || pos - loop.start < MIN_LOOP) return null;
  return { start: loop.start, end: pos, on: true };
}

export function stepSpeed(speed: number, dir: 1 | -1): number {
  return clamp(Math.round((speed + dir * 0.05) * 20) / 20, SPEED_MIN, SPEED_MAX);
}

export function stepPitch(
  pitch: { semitones: number; cents: number },
  dir: 1 | -1,
  fine: boolean,
): { semitones: number; cents: number } {
  if (fine) return { ...pitch, cents: clamp(Math.round(pitch.cents / 5) * 5 + dir * 5, -CENTS_MAX, CENTS_MAX) };
  return { ...pitch, semitones: clamp(Math.round(pitch.semitones) + dir, -SEMITONES_MAX, SEMITONES_MAX) };
}

const sameRange = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01;

/** X: index of the bookmark after the current loop (round), the first one otherwise; -1 if none. */
export function nextBookmark(bookmarks: Bookmark[], loop: Loop): number {
  if (!bookmarks.length) return -1;
  const current = bookmarks.findIndex((b) => sameRange(b, loop));
  return current < 0 ? 0 : (current + 1) % bookmarks.length;
}

/**
 * Context times of the next `count` times an active loop comes round after context time `from`
 * (as the worklet wraps: past the loop's end back to its start). [] when it will not come round.
 */
export function wrapTimes(t: Transport, loop: Loop, from: number, count: number): number[] {
  if (!t.playing || !loopActive(loop) || t.rate <= 0 || count <= 0) return [];
  const len = loop.end - loop.start;
  // A transport starting past the loop's end is wrapped at once (positionAt does the same).
  const pos0 = t.pos < loop.end ? t.pos : loop.start + mod(t.pos - loop.start, len);
  const first = t.at + (loop.end - pos0) / t.rate;
  const period = len / t.rate;
  const skip = from < first ? 0 : Math.floor((from - first) / period) + 1;
  return Array.from({ length: count }, (_, k) => first + (skip + k) * period);
}

/** How many times the loop came round after the transport started and up to context time `now`. */
export function wrapsUntil(t: Transport, loop: Loop, now: number): number {
  if (!t.playing || !loopActive(loop) || t.rate <= 0 || now < t.at) return 0;
  const len = loop.end - loop.start;
  const pos0 = t.pos < loop.end ? t.pos : loop.start + mod(t.pos - loop.start, len);
  const first = t.at + (loop.end - pos0) / t.rate;
  return now < first ? 0 : Math.floor((now - first) / (len / t.rate)) + 1;
}
