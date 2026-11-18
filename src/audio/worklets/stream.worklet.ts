// Plays the guitar stream of the native engine into the analysis graph (tuner, level, notes).
// Chunks arrive from the WebSocket through the port as { left, right } (transferred Float32Arrays).
import { StreamQueue } from '../../dsp/streamQueue';

/** Backlog above this is dropped (a frozen tab that wakes up must not lag by seconds). */
const CAPACITY_SECONDS = 0.2;
/** Cushion against the jitter of the WebSocket. */
const TARGET_SECONDS = 0.03;

class StreamProcessor extends AudioWorkletProcessor {
  private readonly queue = new StreamQueue(
    Math.round(sampleRate * CAPACITY_SECONDS),
    Math.round(sampleRate * TARGET_SECONDS),
  );

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (event: MessageEvent<{ left: Float32Array; right: Float32Array }>) => {
      this.queue.push(event.data.left, event.data.right);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // The node is made with two output channels (graph.ts), so both are there.
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (left && right) this.queue.pull(left, right);
    return true;
  }
}

registerProcessor('kv-stream', StreamProcessor);
