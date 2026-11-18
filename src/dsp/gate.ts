// Noise gate: opens on a played note, closes on hiss. Runs inside an AudioWorklet.
import { dbToLin } from './level';

export interface GateParams {
  thresholdDb: number;
  /** «Шумодав сам»: the threshold rises over the input's own noise (see `GATE_AUTO`). */
  auto?: boolean;
  hysteresisDb?: number;
  attackMs?: number;
  holdMs?: number;
  releaseMs?: number;
}

/** «Шумодав» at this value or lower is off («выкл» on the slider): nothing is gated, by hand or by itself. */
export const GATE_OFF_DB = -90;

/**
 * «Шумодав сам» (2026-11-16). A fixed threshold cannot be right: the author's input at rest holds the
 * gate's envelope at −66 … −60 dBFS (12 Nov), over three of the four presets' thresholds, so after a
 * note the gate never closed and the amp played the noise for good. With `auto` the gate measures
 * the noise itself and opens only `marginDb` over it — never lower than the preset's threshold.
 *
 * What is noise is told by the envelope's shape, half a second at a time: noise is flat (its peak
 * within `flatDb` of its mean; measured 0.9–1.8 dB on hum and hiss), playing has attacks (3.4 dB and
 * more on a real DI). Only flat windows teach the floor:
 *  - a flat window under the floor lowers it at once (never harmful: the gate only opens more);
 *  - `steadyWindows` flat windows in a row within `steadyDb` set it, up or down (the guitar was
 *    plugged in, the player turned to the laptop). A ringing note is flat but fades, so it fails this;
 *  - a flat window less than `nearDb` over the floor raises it by `upDb` (a floor that creeps up).
 * The floor starts at `startDb`, about the author's input, so the first seconds are quiet too. The
 * threshold it sets is capped at `capDb`: whatever goes wrong, this is an ordinary gate at −40 dB.
 * The fast engine has the same (`GateCore` in service/src/kv_guitar/dsp.py), checked value for value.
 */
export const GATE_AUTO = {
  windowS: 0.5,
  flatDb: 3,
  steadyWindows: 10,
  steadyDb: 2,
  marginDb: 8,
  capDb: -40,
  nearDb: 10,
  upDb: 0.25,
  startDb: -64,
  /** A window quieter than this is no input at all (digital silence): it teaches nothing. */
  silentDb: -120,
} as const;

const FLAT = dbToLin(GATE_AUTO.flatDb);
const STEADY = dbToLin(GATE_AUTO.steadyDb);
const MARGIN = dbToLin(GATE_AUTO.marginDb);
const CAP = dbToLin(GATE_AUTO.capDb);
const NEAR = dbToLin(GATE_AUTO.nearDb);
const UP = dbToLin(GATE_AUTO.upDb);
const SILENT = dbToLin(GATE_AUTO.silentDb);

export class GateCore {
  private env = 0;
  private gain = 0;
  private open = false;
  private holdLeft = 0;
  private thresholdDb = -60;
  private auto = false;
  private openLevel = 0;
  private closeLevel = 0;
  private hysteresisDb = 6;
  private holdSamples = 0;
  private gainAttack = 0;
  private gainRelease = 0;
  private readonly envAttack: number;
  private readonly envRelease: number;
  // The noise floor (the envelope's mean at rest), and the window being measured.
  private floor = dbToLin(GATE_AUTO.startDb);
  private readonly window: number;
  private sum = 0;
  private top = 0;
  private count = 0;
  private readonly ring = new Float64Array(GATE_AUTO.steadyWindows);
  private ringAt = 0;
  private flatRun = 0;

  constructor(
    private readonly sampleRate: number,
    params: GateParams,
  ) {
    this.envAttack = this.coef(0.2);
    this.envRelease = this.coef(20);
    this.window = Math.round(GATE_AUTO.windowS * sampleRate);
    this.configure(params);
  }

  configure({ thresholdDb, auto = false, hysteresisDb = 6, attackMs = 1, holdMs = 60, releaseMs = 120 }: GateParams): void {
    this.hysteresisDb = hysteresisDb;
    this.auto = auto;
    this.setThreshold(thresholdDb);
    this.holdSamples = Math.round((holdMs / 1000) * this.sampleRate);
    this.gainAttack = this.coef(attackMs);
    this.gainRelease = this.coef(releaseMs);
  }

  setThreshold(thresholdDb: number): void {
    this.thresholdDb = thresholdDb;
    this.applyLevels();
  }

  setAuto(auto: boolean): void {
    this.auto = auto;
    this.applyLevels();
  }

  /**
   * The input itself got `factor` times louder (the channel pick went from both halves to one
   * side, or back): its noise did too, so what the gate knows of the floor moves with it.
   */
  scaleFloor(factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    this.floor *= factor;
    for (let i = 0; i < this.ring.length; i++) this.ring[i] *= factor;
    this.sum *= factor;
    this.top *= factor;
    this.applyLevels();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** The noise floor as the gate knows it, dBFS of its envelope. */
  get floorDb(): number {
    return 20 * Math.log10(this.floor);
  }

  /** The level that opens the gate now, dBFS: the preset's threshold, or higher when the gate set it itself. */
  get openDb(): number {
    return 20 * Math.log10(this.openLevel);
  }

  process(input: Float32Array, output: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const a = Math.abs(x);
      const k = a > this.env ? this.envAttack : this.envRelease;
      this.env = k * this.env + (1 - k) * a;

      this.sum += this.env;
      if (this.env > this.top) this.top = this.env;
      if (++this.count >= this.window) this.endWindow();

      if (this.env >= this.openLevel) {
        this.open = true;
        this.holdLeft = this.holdSamples;
      } else if (this.open && this.env < this.closeLevel) {
        if (this.holdLeft > 0) this.holdLeft--;
        else this.open = false;
      }

      const target = this.open ? 1 : 0;
      const g = target > this.gain ? this.gainAttack : this.gainRelease;
      this.gain = g * this.gain + (1 - g) * target;
      output[i] = x * this.gain;
    }
  }

  /** Half a second has been heard: what does it say about the noise floor? */
  private endWindow(): void {
    const mean = this.sum / this.count;
    const top = this.top;
    this.sum = 0;
    this.top = 0;
    this.count = 0;
    if (mean < SILENT) return;
    if (top > mean * FLAT) {
      this.flatRun = 0;
      return;
    }
    const ring = this.ring;
    ring[this.ringAt] = mean;
    this.ringAt = (this.ringAt + 1) % ring.length;
    this.flatRun++;
    let lo = ring[0];
    let hi = ring[0];
    for (let i = 1; i < ring.length; i++) {
      const v = ring[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (mean < this.floor) {
      this.floor = mean;
    } else if (this.flatRun >= ring.length && hi <= lo * STEADY) {
      this.floor = lo;
    } else if (mean < this.floor * NEAR) {
      this.floor *= UP;
    }
    this.applyLevels();
  }

  private applyLevels(): void {
    const preset = dbToLin(this.thresholdDb);
    const own = this.auto && this.thresholdDb > GATE_OFF_DB ? Math.min(CAP, this.floor * MARGIN) : 0;
    if (own > preset) {
      this.openLevel = own;
      this.closeLevel = own * dbToLin(-this.hysteresisDb);
    } else {
      this.openLevel = preset;
      this.closeLevel = dbToLin(this.thresholdDb - this.hysteresisDb);
    }
  }

  private coef(ms: number): number {
    return Math.exp(-1 / ((ms / 1000) * this.sampleRate));
  }
}
