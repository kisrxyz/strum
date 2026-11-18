// Web Audio building blocks after the amp: EQ, cabinet, chorus, delay, reverb.
import { irInBandGainDb } from '../dsp/irGain';
import { dbToLin } from '../dsp/level';
import type { ChorusSettings, DelaySettings, ReverbSettings } from '../state/presets';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Click-free parameter change. */
export function smooth(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant = 0.03): void {
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, timeConstant);
}

function stereoGain(ctx: BaseAudioContext): GainNode {
  const node = ctx.createGain();
  node.channelCount = 2;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers'; // mono input is copied to both sides
  return node;
}

export interface Block {
  input: AudioNode;
  output: AudioNode;
}

/**
 * A slot whose inner node can be replaced on the fly (cabinet, reverb).
 * The old and new nodes crossfade so the switch does not click.
 */
class SwapSlot {
  private current: { input: AudioNode; output: AudioNode; gain: GainNode } | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly from: AudioNode,
    private readonly to: AudioNode,
  ) {}

  /** Puts a new inner chain (`input` … `output`) in place of the old one. */
  swap(input: AudioNode, output: AudioNode = input): void {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    this.from.connect(input);
    output.connect(gain).connect(this.to);
    smooth(gain.gain, 1, this.ctx, 0.02);
    const old = this.current;
    this.current = { input, output, gain };
    if (old) {
      smooth(old.gain.gain, 0, this.ctx, 0.02);
      setTimeout(() => {
        this.from.disconnect(old.input);
        old.gain.disconnect();
        old.output.disconnect();
        old.input.disconnect();
      }, 200);
    }
  }
}

export function createEq(ctx: BaseAudioContext): Block & { set(bass: number, mid: number, treble: number): void } {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 750;
  mid.Q.value = 0.8;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 3000;
  low.connect(mid).connect(high);
  return {
    input: low,
    output: high,
    set(b, m, t) {
      smooth(low.gain, clamp(b, -12, 12), ctx);
      smooth(mid.gain, clamp(m, -12, 12), ctx);
      smooth(high.gain, clamp(t, -12, 12), ctx);
    },
  };
}

/** Cabinet impulse response; `null` passes the amp straight through. */
export function createCabinet(ctx: BaseAudioContext): Block & { setIr(buffer: AudioBuffer | null): void } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const slot = new SwapSlot(ctx, input, output);
  // Pass the amp straight through until (or unless) an IR loads.
  slot.swap(ctx.createGain());
  return {
    input,
    output,
    setIr(buffer) {
      if (!buffer) {
        slot.swap(ctx.createGain());
        return;
      }
      // Unity gain in the guitar band, so switching cabinets does not change the volume.
      const convolver = new ConvolverNode(ctx, { buffer, disableNormalization: true });
      const trim = new GainNode(ctx, { gain: dbToLin(irInBandGainDb(buffer.getChannelData(0), buffer.sampleRate)) });
      convolver.connect(trim);
      slot.swap(convolver, trim);
    },
  };
}

/** Stereo chorus: two modulated delays swinging in opposite directions (Roland JC style). */
export function createChorus(ctx: BaseAudioContext): Block & { set(p: ChorusSettings): void } {
  const input = ctx.createGain();
  const output = stereoGain(ctx);
  const dry = ctx.createGain();
  input.connect(dry).connect(output);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  const merger = ctx.createChannelMerger(2);
  const wet = ctx.createGain();
  wet.gain.value = 0;
  const sides = [1, -1].map((sign, channel) => {
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.012;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    lfo.connect(depth).connect(delay.delayTime);
    input.connect(delay).connect(merger, 0, channel);
    return { depth, sign };
  });
  merger.connect(wet).connect(output);
  lfo.start();

  return {
    input,
    output,
    set(p) {
      smooth(lfo.frequency, clamp(p.rate, 0.05, 5), ctx);
      const depthSeconds = 0.0005 + clamp(p.depth, 0, 1) * 0.004;
      for (const side of sides) smooth(side.depth.gain, side.sign * depthSeconds, ctx);
      smooth(wet.gain, p.on ? clamp(p.mix, 0, 1) : 0, ctx);
      smooth(dry.gain, p.on ? 1 - 0.3 * clamp(p.mix, 0, 1) : 1, ctx);
    },
  };
}

/** Darkening tape-style echo. Turning it off stops new input but lets the repeats ring out. */
export function createDelay(ctx: BaseAudioContext): Block & { set(p: DelaySettings): void } {
  const input = ctx.createGain();
  const output = stereoGain(ctx);
  input.connect(output);

  const send = ctx.createGain();
  send.gain.value = 0;
  const delay = ctx.createDelay(2);
  const lowCut = ctx.createBiquadFilter();
  lowCut.type = 'highpass';
  lowCut.frequency.value = 120;
  const highCut = ctx.createBiquadFilter();
  highCut.type = 'lowpass';
  highCut.frequency.value = 3500;
  const feedback = ctx.createGain();
  feedback.gain.value = 0;
  const wet = ctx.createGain();
  wet.gain.value = 0;

  input.connect(send).connect(delay).connect(lowCut).connect(highCut);
  highCut.connect(feedback).connect(delay);
  highCut.connect(wet).connect(output);

  return {
    input,
    output,
    set(p) {
      smooth(delay.delayTime, clamp(p.timeMs, 20, 1500) / 1000, ctx, 0.05);
      smooth(feedback.gain, clamp(p.feedback, 0, 0.9), ctx);
      smooth(wet.gain, clamp(p.mix, 0, 1), ctx);
      smooth(send.gain, p.on ? 1 : 0, ctx);
    },
  };
}

/** Convolution reverb with a spring or plate impulse response. */
export function createReverb(
  ctx: BaseAudioContext,
): Block & { set(p: ReverbSettings): void; setIr(buffer: AudioBuffer): void } {
  const input = ctx.createGain();
  const output = stereoGain(ctx);
  input.connect(output);
  const send = ctx.createGain();
  send.gain.value = 0;
  input.connect(send);
  const slot = new SwapSlot(ctx, send, output);
  return {
    input,
    output,
    set(p) {
      smooth(send.gain, p.on ? clamp(p.mix, 0, 1) * 0.8 : 0, ctx);
    },
    setIr(buffer) {
      const convolver = ctx.createConvolver();
      convolver.buffer = buffer;
      slot.swap(convolver);
    },
  };
}
