// «Запись»: taps a node of an AudioContext (what goes to the speakers), and tells when a frame of
// that context reached the speakers.
import tapWorkletUrl from '../audio/worklets/tap.worklet.ts?worker&url';

// The processor's name, as `tap.worklet.ts` registers it (that file cannot be imported here).
const TAP_PROCESSOR = 'kv-tap';

/** One block of a recorded track: its first frame on its source's clock, and the samples. */
export type BlockSink = (frame: number, left: Float32Array, right: Float32Array) => void;

/** Where one track of a take comes from. */
export interface TrackSource {
  /** Frames a second. */
  readonly rate: number;
  /** performance.now() at which the player lived frame `frame` of this source; null if not known yet. */
  moment(frame: number): number | null;
  /** Stops sending blocks. */
  stop(): void;
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Sends what `from` plays to `onBlock` until the returned function is called. */
export async function tapNode(ctx: AudioContext, from: AudioNode, onBlock: BlockSink): Promise<() => void> {
  let ready = loaded.get(ctx);
  if (!ready) {
    ready = ctx.audioWorklet.addModule(tapWorkletUrl);
    loaded.set(ctx, ready);
    ready.catch(() => loaded.delete(ctx));
  }
  await ready;
  const node = new AudioWorkletNode(ctx, TAP_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  node.port.onmessage = (event: MessageEvent<{ frame: number; left: Float32Array; right: Float32Array }>) => {
    const { frame, left, right } = event.data;
    onBlock(frame, left, right);
  };
  from.connect(node);
  return () => {
    node.port.onmessage = null;
    try {
      from.disconnect(node);
    } catch {
      /* the graph is already gone */
    }
  };
}

/** performance.now() at which frame `frame` of `ctx` reaches (reached) the speakers. */
export function audibleMoment(ctx: AudioContext, frame: number): number {
  const at = frame / ctx.sampleRate;
  const ts = ctx.getOutputTimestamp();
  if (ts.contextTime && ts.performanceTime) return ts.performanceTime + (at - ts.contextTime) * 1000;
  // Not playing yet: the frame being rendered now goes out after the output latency.
  return performance.now() + (at - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
}
