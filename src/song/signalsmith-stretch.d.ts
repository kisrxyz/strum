// Types for signalsmith-stretch 1.3.2 (the package ships none), from its README and source.
declare module 'signalsmith-stretch' {
  export interface StretchChange {
    /** Context time of the change; the node compensates its own latency. */
    output?: number;
    active?: boolean;
    /** Position in the loaded buffers, seconds. */
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    /** Equal values switch the loop off. */
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    configure(config: { blockMs?: number; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<void>;
    schedule(change: StretchChange): Promise<unknown>;
    start(when?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    /** Appends one chunk: one array per channel, all of the same length. Returns the new end time. */
    addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    latency(): Promise<number>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}
