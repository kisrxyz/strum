// The chord lane glides: while the song plays, the browser moves it in a straight line on its own
// (a compositor animation), so frames that the page spends on other work cannot make it stutter.
// Every frame the page only checks the glide against the song and starts a new one when needed.

/** A straight run: at frame time `t0` (ms) the lane is at `x0` px and moves `v` px per ms until `t1`. */
export interface Glide {
  t0: number;
  x0: number;
  v: number;
  t1: number;
}

/** Where the glide has the lane at frame time `now` (it stands still after `t1`). */
export function glideAt(g: Glide, now: number): number {
  return g.x0 + g.v * (Math.min(now, g.t1) - g.t0);
}

/** How far the lane may be off before a new glide starts, px. */
export const GLIDE_TOLERANCE = 0.75;

/**
 * True when the running glide still shows the lane in the right place (`x` at `now`) at the right
 * speed `v`. False after a seek, a loop wrap, a speed change, a resize, or the end of the run.
 */
export function glideHolds(g: Glide | null, x: number, v: number, now: number): boolean {
  return g !== null && g.v === v && now < g.t1 && Math.abs(glideAt(g, now) - x) <= GLIDE_TOLERANCE;
}
