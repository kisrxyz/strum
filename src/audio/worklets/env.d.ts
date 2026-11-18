// Globals of AudioWorkletGlobalScope (not part of TypeScript's DOM library).

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

/** Sample rate of the AudioContext the worklet runs in (worklet scope only). */
declare const sampleRate: number;

/** The context frame of the render quantum being processed (worklet scope only). */
declare const currentFrame: number;
