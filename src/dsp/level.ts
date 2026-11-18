// Levels in dB, meter ballistics and input-level zones.

export const MIN_DB = -120;

export function linToDb(x: number): number {
  return x > 0 ? Math.max(MIN_DB, 20 * Math.log10(x)) : MIN_DB;
}

export function dbToLin(db: number): number {
  return 10 ** (db / 20);
}

export function measure(buf: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: buf.length ? Math.sqrt(sum / buf.length) : 0 };
}

/** Meter that jumps up instantly, falls at a steady rate and holds the recent peak. */
export class MeterBallistics {
  private level = MIN_DB;
  private hold = MIN_DB;
  private holdAt = 0;
  private lastAt: number | null = null;

  constructor(
    private readonly fallDbPerSec = 24,
    private readonly holdMs = 1500,
  ) {}

  update(peakDb: number, nowMs: number): { levelDb: number; holdDb: number } {
    const dt = this.lastAt === null ? 0 : (nowMs - this.lastAt) / 1000;
    this.lastAt = nowMs;
    this.level = peakDb >= this.level ? peakDb : Math.max(peakDb, this.level - this.fallDbPerSec * dt);
    if (peakDb >= this.hold || nowMs - this.holdAt > this.holdMs) {
      this.hold = peakDb >= this.hold ? peakDb : this.level;
      this.holdAt = nowMs;
    }
    return { levelDb: this.level, holdDb: this.hold };
  }
}

export type LevelZone = 'silent' | 'low' | 'soft' | 'good' | 'hot' | 'clip';

/**
 * The amps are levelled for a guitar whose hard strum peaks at −9 dBFS. They answer to the level
 * as real amps do: 12 dB quieter (16 Nov 2026, a real DI) the clean and the crunch presets are
 * 10–12 dB quieter and the crunch has lost its crunch, while the driven ones lose 2 dB. So «good»
 * is a strum that reaches −16 … −6 dBFS, and a quieter one that still plays is «soft».
 */
export const GOOD_FROM_DB = -16;
export const GOOD_TO_DB = -6;

/**
 * Where an input peak level sits: from "nothing plugged in" to "clipping". `peakDb` is what the
 * amps get (after «Подстроить под мою гитару»), `rawPeakDb` what the card gave: only the card
 * itself can overload, and only the card's silence is «nothing plugged in».
 */
export function levelZone(peakDb: number, rawPeakDb = peakDb): LevelZone {
  if (rawPeakDb >= -0.5) return 'clip';
  if (rawPeakDb < -60) return 'silent';
  if (peakDb < -30) return 'low';
  if (peakDb < GOOD_FROM_DB) return 'soft';
  if (peakDb <= GOOD_TO_DB) return 'good';
  return 'hot';
}
