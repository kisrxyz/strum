// Which mains frequency hums in the input: 50 Hz (Europe, Russia, Asia…) or 60 Hz (the Americas,
// part of Japan…). The hum filter («Фильтр гула», analysis.ts / dsp.py) notches the one heard.
// It listens only in quiet windows (no playing): there the hum and its harmonics stand out.

export type MainsHz = 50 | 60;

/** A window louder than this is playing, not resting (dBFS RMS). */
const QUIET_DB = -40;
/** Digital silence (a muted input) says nothing. */
const SILENCE_MS = 1e-12;
const HARMONICS = 4;
/** The hum family must hold this share of the window's energy... */
const MIN_SHARE = 0.2;
/** ...and be this many times the other family's. */
const MIN_RATIO = 4;
const VOTES = 3;

/** Energy (amplitude² / 2) of a sine at `hz` in `x`: Goertzel. */
function sineEnergy(x: Float32Array, rate: number, hz: number): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  const amp = (2 * Math.sqrt(Math.max(0, power))) / x.length;
  return (amp * amp) / 2;
}

const family = (x: Float32Array, rate: number, hz: number) => {
  let e = 0;
  for (let k = 1; k <= HARMONICS; k++) e += sineEnergy(x, rate, hz * k);
  return e;
};

/** The mains this quiet window hums at, or null (playing, silent, or no clear hum). ≥ 0.25 s. */
export function mainsVote(x: Float32Array, rate: number): MainsHz | null {
  let ms = 0;
  for (let i = 0; i < x.length; i++) ms += x[i] * x[i];
  ms /= x.length || 1;
  if (ms < SILENCE_MS || 10 * Math.log10(ms) > QUIET_DB) return null;
  const e50 = family(x, rate, 50);
  const e60 = family(x, rate, 60);
  const [hz, e, other] = e50 >= e60 ? ([50, e50, e60] as const) : ([60, e60, e50] as const);
  if (e < MIN_SHARE * ms || e < MIN_RATIO * other) return null;
  return hz;
}

/** Three agreeing votes in a row decide; a vote the other way starts over. */
export class MainsDetector {
  private last: MainsHz | null = null;
  private count = 0;

  /** The decided mains, once (null until then, and for every window that does not decide). */
  push(x: Float32Array, rate: number): MainsHz | null {
    const vote = mainsVote(x, rate);
    if (vote === null) return null;
    this.count = vote === this.last ? this.count + 1 : 1;
    this.last = vote;
    if (this.count !== VOTES) return null;
    return vote;
  }
}
