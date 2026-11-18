// The amp itself: a NAM model (main sound) or the simple Web Audio amp (fallback).
// The NAM engine already brings every model with loudness metadata to -18 dB, and the drive
// knob behaves like on a real amp: a clean amp gets louder, a saturated one mostly dirtier.
import type { NamEngine, NamNode } from 'neural-amp-modeler-wasm/engine';
import { makeDriveCurve } from '../dsp/curves';
import { dbToLin } from '../dsp/level';
import { L } from '../i18n';
import { SIMPLE_AMP, loadModelJson } from './assets';
import { smooth } from './effects';

/** Slimmable (A2) models switch to their smaller sub-model below 0.5. */
const SLIM_SIZE = 0.3;

export type AmpLoadResult = { kind: 'nam' } | { kind: 'simple'; error?: string } | { kind: 'stale' };

export class AmpSlot {
  /** Drive: the gain in front of the amp. */
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly namSend: GainNode;
  private readonly simpleSend: GainNode;
  private nam: NamNode | null = null;
  private namLoaded = false;
  private loadToken = 0;

  private constructor(private readonly ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.namSend = ctx.createGain();
    this.namSend.gain.value = 0;
    this.simpleSend = ctx.createGain();
    this.input.connect(this.namSend);
    this.input.connect(this.simpleSend);
    this.buildSimpleAmp();
  }

  static async create(ctx: BaseAudioContext, engine: NamEngine | null): Promise<AmpSlot> {
    const slot = new AmpSlot(ctx);
    if (engine) {
      try {
        slot.nam = await engine.createNode();
        slot.namSend.connect(slot.nam).connect(slot.output);
      } catch (error) {
        console.warn('[amp] NAM node failed, using the simple amp', error);
        slot.nam = null;
      }
    }
    return slot;
  }

  get hasNam(): boolean {
    return this.nam !== null;
  }

  setDrive(inputDb: number): void {
    smooth(this.input.gain, dbToLin(inputDb), this.ctx);
  }

  async setModel(id: string, slim: boolean): Promise<AmpLoadResult> {
    const token = ++this.loadToken;
    if (id === SIMPLE_AMP) {
      this.routeSimple();
      return { kind: 'simple' };
    }
    if (!this.nam) {
      this.routeSimple();
      return { kind: 'simple', error: L().amp.modelsUnsupported };
    }
    try {
      const json = await loadModelJson(id);
      if (token !== this.loadToken) return { kind: 'stale' };
      await this.nam.loadModel(json, slim ? { slimSize: SLIM_SIZE } : undefined);
      if (token !== this.loadToken) return { kind: 'stale' };
      this.namLoaded = true;
      this.routeNam();
      return { kind: 'nam' };
    } catch (error) {
      if (token !== this.loadToken) return { kind: 'stale' };
      this.routeSimple();
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: 'simple', error: L().amp.modelFailed(reason) };
    }
  }

  private routeNam(): void {
    smooth(this.namSend.gain, 1, this.ctx, 0.01);
    smooth(this.simpleSend.gain, 0, this.ctx, 0.01);
  }

  private routeSimple(): void {
    smooth(this.namSend.gain, 0, this.ctx, 0.01);
    smooth(this.simpleSend.gain, 1, this.ctx, 0.01);
    if (this.nam && this.namLoaded) {
      this.namLoaded = false;
      // An empty NAM node is a cheap pass-through; frees the CPU while the simple amp plays.
      void this.nam.unloadModel().catch(() => undefined);
    }
  }

  /** Classic waveshaper amp: tight low end, tube-ish saturation, speaker-like top cut. */
  private buildSimpleAmp(): void {
    const ctx = this.ctx;
    const tight = ctx.createBiquadFilter();
    tight.type = 'highpass';
    tight.frequency.value = 90;
    const pre = ctx.createGain();
    pre.gain.value = dbToLin(20);
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDriveCurve();
    shaper.oversample = '4x';
    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 20;
    const topCut = ctx.createBiquadFilter();
    topCut.type = 'lowpass';
    topCut.frequency.value = 6000;
    const post = ctx.createGain();
    post.gain.value = dbToLin(-12);
    this.simpleSend.connect(tight).connect(pre).connect(shaper).connect(dcBlock).connect(topCut).connect(post);
    post.connect(this.output);
  }
}
