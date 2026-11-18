// Noise gate processor, runs on the audio thread. Threshold changes arrive as port messages.
import { GateCore } from '../../dsp/gate';

export const GATE_PROCESSOR = 'kv-gate';

/** Every field is optional: a message changes what it names. */
interface GateMessage {
  thresholdDb?: number;
  /** «Шумодав сам». */
  auto?: boolean;
  /** The input got this many times louder (the channel pick changed): the learned floor moves with it. */
  floorGain?: number;
}

class GateProcessor extends AudioWorkletProcessor {
  private readonly core: GateCore;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const initial = (options?.processorOptions as { thresholdDb?: number } | undefined)?.thresholdDb ?? -60;
    this.core = new GateCore(sampleRate, { thresholdDb: initial });
    this.port.onmessage = (event: MessageEvent<GateMessage>) => {
      const { thresholdDb, auto, floorGain } = event.data;
      if (auto !== undefined) this.core.setAuto(auto);
      if (thresholdDb !== undefined) this.core.setThreshold(thresholdDb);
      if (floorGain !== undefined) this.core.scaleFloor(floorGain);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (input) this.core.process(input, output);
    else output.fill(0);
    return true;
  }
}

registerProcessor(GATE_PROCESSOR, GateProcessor);
