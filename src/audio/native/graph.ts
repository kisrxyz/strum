// The audio graph of the native path: analysis only. The guitar's sound is made (and heard)
// outside the browser; this context just reads the engine's raw input stream to feed the level
// meter, the tuner, the note trail and «Проверь меня».
import { buildAnalysis } from '../analysis';
import type { EngineState } from './protocol';

/** Registered by worklets/stream.worklet.ts. */
export const STREAM_PROCESSOR = 'kv-stream';

/**
 * The context runs at the engine's sample rate, so the stream plays in without resampling and the
 * analysers read true frequencies. It makes no sound, so it asks for the relaxed latency.
 * `make` is a seam for tests.
 */
export function createNativeContext(
  state: EngineState,
  make: (options: AudioContextOptions) => AudioContext = (options) => new AudioContext(options),
): AudioContext {
  return make({ sampleRate: state.sampleRate, latencyHint: 'playback' });
}

/**
 * stream worklet → splitter → the shared analysis nodes. Nothing goes to the speakers: a muted
 * gain to `destination` only keeps the context rendering. Both worklet modules must be added to
 * `ctx` before this.
 */
export function buildNativeGraph(ctx: AudioContext) {
  const analysis = buildAnalysis(ctx);
  const stream = new AudioWorkletNode(ctx, STREAM_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  stream.connect(analysis.splitter);
  const keepAlive = ctx.createGain();
  keepAlive.gain.value = 0;
  stream.connect(keepAlive);
  keepAlive.connect(ctx.destination);
  return { ...analysis, stream, keepAlive };
}

export type NativeGraph = ReturnType<typeof buildNativeGraph>;
