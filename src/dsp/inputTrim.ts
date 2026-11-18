// «Подстроить под мою гитару» (2026-11-16): the input's own digital gain, set from a few hard strums so
// that the hardest one reaches the level the amps were levelled for — whatever the guitar's pickups
// and the card's Gain knob. The amps answer to the level as real ones do (12 dB quieter, the clean
// and the crunch presets come out 10–12 dB quieter and the crunch stops crunching), so this is what
// makes the presets sound as meant. No DOM; the engine applies the gain (`setInputTrim`).

/** The presets are levelled for a guitar whose hardest strum peaks here (a real DI). */
export const TRIM_TARGET_DB = -9;
export const TRIM_MIN_DB = -12;
export const TRIM_MAX_DB = 24;
/** Quieter than this nothing is being played (no cable, the wrong input). */
export const TRIM_HEARD_DB = -50;
/** This close to full scale the card itself overloads: its Gain knob, not the trim, has to go down. */
const CLIP_DB = -1;
/** How long it listens after the first strum, and how long it waits for one. */
export const TRIM_LISTEN_MS = 5000;
export const TRIM_WAIT_MS = 12000;

export type TrimVerdict = 'ok' | 'clip' | 'weak' | 'silent';

export interface TrimResult {
  verdict: TrimVerdict;
  /** The trim to set, dB (0.5 dB steps); null: leave it as it is (nothing was heard). */
  trimDb: number | null;
  /** The hardest strum heard, dBFS before the trim. */
  peakDb: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** A whole number of half decibels inside the trim's range. */
export function cleanTrim(db: number): number {
  return Number.isFinite(db) ? Math.round(clamp(db, TRIM_MIN_DB, TRIM_MAX_DB) * 2) / 2 : 0;
}

/** What the hardest strum, peaking at `peakDb` before any trim, asks of the trim. */
export function trimFor(peakDb: number): TrimResult {
  if (!(peakDb >= TRIM_HEARD_DB)) return { verdict: 'silent', trimDb: null, peakDb };
  const wanted = TRIM_TARGET_DB - peakDb;
  const verdict: TrimVerdict = peakDb >= CLIP_DB ? 'clip' : wanted > TRIM_MAX_DB ? 'weak' : 'ok';
  return { verdict, trimDb: cleanTrim(wanted), peakDb };
}

/**
 * Listens for strums, one frame's raw peak at a time: waits for the first one (up to
 * `TRIM_WAIT_MS`), then takes the hardest peak over `TRIM_LISTEN_MS`.
 */
export class TrimListener {
  private max = Number.NEGATIVE_INFINITY;
  private firstAt: number | null = null;
  private strums = 0;
  private rearmed = true;

  constructor(private readonly startedAt: number) {}

  /** How far it got, 0…1 (the waiting counts as 0). */
  progress(now: number): number {
    return this.firstAt === null ? 0 : clamp((now - this.firstAt) / TRIM_LISTEN_MS, 0, 1);
  }

  /** Strums heard so far (for the dots on screen). */
  get heard(): number {
    return this.strums;
  }

  /** One frame: the raw input's peak (dBFS) at `now` ms. The result once it has heard enough, else null. */
  push(peakDb: number, now: number): TrimResult | null {
    if (peakDb >= TRIM_HEARD_DB) {
      if (this.firstAt === null) this.firstAt = now;
      if (peakDb > this.max) this.max = peakDb;
    }
    // A strum: within 12 dB of the hardest so far, after the input fell 6 dB under that since the last one.
    const strumAt = Math.max(TRIM_HEARD_DB, this.max - 12);
    if (peakDb >= strumAt && this.rearmed && this.firstAt !== null) {
      this.strums++;
      this.rearmed = false;
    } else if (peakDb < strumAt - 6) {
      this.rearmed = true;
    }
    if (this.firstAt === null) return now - this.startedAt >= TRIM_WAIT_MS ? trimFor(this.max) : null;
    return now - this.firstAt >= TRIM_LISTEN_MS ? trimFor(this.max) : null;
  }
}
