// The part of the graph both guitar paths share: the input's L / R split, the channel pick, the
// analysers (meter, tuner, notes, «Проверь меня») and the noise gate that feeds the spectrum.
// In the browser path the amp chain hangs on the gate; in the native path nothing does.

import type { MainsHz } from '../dsp/mains';
import { smooth } from './effects';

/** Registered by worklets/gate.worklet.ts (which cannot be imported here: it only runs in the worklet). */
const GATE_PROCESSOR = 'kv-gate';

export function makeAnalyser(ctx: BaseAudioContext, fftSize: number): AnalyserNode {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  return analyser;
}

/**
 * The hum filter: notches at the mains (50 or 60 Hz, src/dsp/mains.ts) and its first harmonics, 2 Hz wide — a note next to one loses at
 * most 1 dB, the hum (with the mains 0.05 Hz off) 26 dB at 50 Hz down to 11 dB at 300 Hz. Biquads
 * add no latency. The notches always run; `set` mixes them in or out without a click. The fast
 * engine has the same (`HumFilter` in service/src/kv_guitar/dsp.py).
 */
export const HUM_HZ: MainsHz = 50;
export const HUM_HARMONICS = 6;
export const HUM_BANDWIDTH_HZ = 2;

export function createHumFilter(ctx: BaseAudioContext, mainsHz: MainsHz = HUM_HZ) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = 1;
  wet.gain.value = 0;
  input.connect(dry).connect(output);
  let tail: AudioNode = input;
  const notches: BiquadFilterNode[] = [];
  const tune = (hz: MainsHz) =>
    notches.forEach((notch, i) => {
      notch.frequency.value = hz * (i + 1);
      notch.Q.value = (hz * (i + 1)) / HUM_BANDWIDTH_HZ;
    });
  for (let k = 1; k <= HUM_HARMONICS; k++) {
    const notch = ctx.createBiquadFilter();
    notch.type = 'notch';
    notches.push(notch);
    tail.connect(notch);
    tail = notch;
  }
  tune(mainsHz);
  let mains = mainsHz;
  tail.connect(wet).connect(output);
  return {
    input,
    output,
    set(on: boolean) {
      smooth(wet.gain, on ? 1 : 0, ctx);
      smooth(dry.gain, on ? 0 : 1, ctx);
    },
    /** 50 or 60 Hz: the notches move at once (a moment of ringing at most, once per change). */
    setMains(hz: MainsHz) {
      if (hz === mains) return;
      mains = hz;
      tune(hz);
    },
  };
}

/**
 * `splitter` takes the stereo input. The L / R analysers see the raw channels, `gainL` / `gainR`
 * pick the guitar's channel into `mono` (the pitch analyser's input), `trim` («Подстроить под мою
 * гитару») gives it its own gain, the hum filter takes it to the gate, and the gate feeds the
 * spectrum analyser. The gate's output is free for the amp chain.
 */
export function buildAnalysis(ctx: AudioContext) {
  const splitter = ctx.createChannelSplitter(2);
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = 'explicit';
  splitter.connect(gainL, 0).connect(mono);
  splitter.connect(gainR, 1).connect(mono);

  const anL = makeAnalyser(ctx, 2048);
  const anR = makeAnalyser(ctx, 2048);
  const anMono = makeAnalyser(ctx, 4096);
  splitter.connect(anL, 0);
  splitter.connect(anR, 1);
  mono.connect(anMono);

  const gate = new AudioWorkletNode(ctx, GATE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { thresholdDb: -60 },
  });
  // «Проверь меня»: the gated guitar's spectrum (a tap: it adds nothing to the sound's path).
  const anSpec = makeAnalyser(ctx, 8192);
  anSpec.smoothingTimeConstant = 0.5;
  const trim = ctx.createGain();
  const hum = createHumFilter(ctx);
  mono.connect(trim).connect(hum.input);
  hum.output.connect(gate);
  // The input before the hum filter, for telling 50 Hz mains from 60 Hz (src/dsp/mains.ts): 0.68 s.
  const humTap = ctx.createAnalyser();
  humTap.fftSize = 32768;
  trim.connect(humTap);
  gate.connect(anSpec);

  return { splitter, gainL, gainR, mono, anL, anR, anMono, trim, hum, humTap, gate, anSpec };
}

export type Analysis = ReturnType<typeof buildAnalysis>;
