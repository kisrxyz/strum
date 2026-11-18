// «Запись»: pure helpers of the recorder — when the player lived a recorded frame, and the chunks
// the song service gets. No DOM.

/**
 * Engine frames → performance.now() for the native path.
 *
 * A piece of audio cannot reach the browser before the engine made it, and most pieces wait a
 * little in queues on the way. So the earliest arrival seen, measured against the frame clock, is
 * the best guess of the offset between the two clocks: the minimum over the last few seconds
 * (one-second buckets, so a slow drift of one clock against the other is followed).
 */
export class ArrivalClock {
  private readonly buckets: number[] = [];
  private bucketStart = Number.NEGATIVE_INFINITY;

  constructor(
    readonly rate: number,
    private readonly bucketMs = 1000,
    private readonly keep = 8,
  ) {}

  /** A piece whose frames end before `frameEnd` arrived at `arrivedMs` (performance.now()). */
  note(frameEnd: number, arrivedMs: number): void {
    const offset = arrivedMs - (frameEnd * 1000) / this.rate;
    const last = this.buckets.length - 1;
    if (last < 0 || arrivedMs - this.bucketStart >= this.bucketMs) {
      this.buckets.push(offset);
      this.bucketStart = arrivedMs;
      if (this.buckets.length > this.keep) this.buckets.shift();
    } else if (offset < this.buckets[last]!) {
      this.buckets[last] = offset;
    }
  }

  /** performance.now() when the engine made frame `frame`; null before anything arrived. */
  moment(frame: number): number | null {
    if (!this.buckets.length) return null;
    return (frame * 1000) / this.rate + Math.min(...this.buckets);
  }
}

/** Stereo float blocks → 16-bit little-endian interleaved PCM, clipped. */
export function toPcm16(parts: readonly (readonly [Float32Array, Float32Array])[], frames: number): Int16Array {
  const out = new Int16Array(frames * 2);
  let at = 0;
  for (const [left, right] of parts) {
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]!));
      const r = Math.max(-1, Math.min(1, right[i]!));
      out[at++] = Math.round(l * 32767);
      out[at++] = Math.round(r * 32767);
    }
  }
  return out;
}

export interface Chunk {
  /** The chunk's first frame in its track. */
  at: number;
  frames: number;
  /** L, R, L, R… */
  data: Int16Array;
}

/**
 * Gathers one track's blocks into chunks of about `size` frames. A block that does not follow the
 * previous one (frames lost on the way) closes the chunk: the next one starts at its own frame,
 * and the service leaves silence in the gap. Frames already had (a repeated block) are skipped.
 */
export class TrackChunker {
  private parts: [Float32Array, Float32Array][] = [];
  private start = 0;
  private count = 0;
  private next = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly size: number,
    private readonly emit: (chunk: Chunk) => void,
  ) {}

  push(frame: number, left: Float32Array, right: Float32Array): void {
    if (frame < this.next) {
      const skip = this.next - frame;
      if (skip >= left.length) return;
      left = left.subarray(skip);
      right = right.subarray(skip);
      frame = this.next;
    }
    if (this.count > 0 && frame !== this.next) this.flush();
    if (this.count === 0) this.start = frame;
    this.parts.push([left, right]);
    this.count += left.length;
    this.next = frame + left.length;
    if (this.count >= this.size) this.flush();
  }

  /** Sends what is gathered (at the end of a recording, or at a gap). */
  flush(): void {
    if (!this.count) return;
    const chunk = { at: this.start, frames: this.count, data: toPcm16(this.parts, this.count) };
    this.parts = [];
    this.count = 0;
    this.emit(chunk);
  }
}

/**
 * The part of a block at frame `from` or after it, as [its first frame, left, right]; null when the
 * whole block lies before. The dry input starts at the guitar's first frame: what came earlier goes.
 */
export function fromFrame(
  from: number,
  frame: number,
  left: Float32Array,
  right: Float32Array,
): [number, Float32Array, Float32Array] | null {
  const skip = from - frame;
  if (skip <= 0) return [frame, left, right];
  if (skip >= left.length) return null;
  return [from, left.subarray(skip), right.subarray(skip)];
}

/** True when a chunk is digital silence (nothing worth sending: a gap reads back as silence). */
export function isSilent(data: Int16Array): boolean {
  for (let i = 0; i < data.length; i++) if (data[i] !== 0) return false;
  return true;
}
