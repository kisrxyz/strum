// A small jitter buffer for the guitar stream that comes from the native engine: the WebSocket
// delivers 10 ms chunks whenever the browser gets round to it, the audio thread takes 128 frames
// at an even pace. The stream worklet (`stream.worklet.ts`) wraps this class.

/**
 * A ring buffer of stereo frames.
 *
 * - Playback starts once `targetFrames` are queued (the cushion), and stops again after an
 *   underrun until the cushion is rebuilt. When it starts, only the newest `targetFrames` are
 *   kept: after a stall of the main thread the backlog that arrives in one go must not become
 *   a lag that stays for the rest of the session (input and output run at the same rate).
 * - Nothing here is allocated after construction, so `push` and `pull` are safe on the audio thread.
 * - If audio piles up past `capacityFrames` (a frozen tab that wakes up, or a card clock a little
 *   faster than the browser's), the oldest audio is dropped and the queue keeps the newest part
 *   down to the cushion's size. Dropping only the excess would hold the lag at the cap for good.
 */
export class StreamQueue {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private head = 0;
  private count = 0;
  private primed = false;

  constructor(
    readonly capacityFrames: number,
    readonly targetFrames: number,
  ) {
    if (!Number.isInteger(capacityFrames) || capacityFrames < 1) throw new RangeError('capacity must be a whole number of frames');
    if (!Number.isInteger(targetFrames) || targetFrames < 0 || targetFrames > capacityFrames) {
      throw new RangeError('target must be a whole number of frames, not above the capacity');
    }
    this.left = new Float32Array(capacityFrames);
    this.right = new Float32Array(capacityFrames);
  }

  /** Frames waiting to be played. */
  get fill(): number {
    return this.count;
  }

  /** Queues a chunk. If the two channels differ in length, the extra samples are ignored. */
  push(left: Float32Array, right: Float32Array): void {
    const n = Math.min(left.length, right.length);
    if (n === 0) return;
    const cap = this.capacityFrames;
    let from = 0; // the first frame of the chunk that is kept
    if (this.count + n > cap) {
      const keep = Math.min(cap, Math.max(this.targetFrames, n));
      const drop = this.count + n - keep;
      if (drop >= this.count) {
        from = drop - this.count;
        this.count = 0;
      } else {
        this.head = (this.head + drop) % cap;
        this.count -= drop;
      }
    }
    let write = (this.head + this.count) % cap;
    while (from < n) {
      const run = Math.min(n - from, cap - write);
      this.left.set(left.subarray(from, from + run), write);
      this.right.set(right.subarray(from, from + run), write);
      write = (write + run) % cap;
      from += run;
      this.count += run;
    }
  }

  /**
   * Fills the output blocks. Returns false, with both blocks set to silence, while the cushion is
   * being built and on an underrun (a block is never half silence).
   */
  pull(outLeft: Float32Array, outRight: Float32Array): boolean {
    const n = outLeft.length;
    if (!this.primed) {
      const need = Math.max(this.targetFrames, n);
      if (this.count < need) return this.silence(outLeft, outRight);
      this.primed = true;
      if (this.count > need) {
        this.head = (this.head + this.count - need) % this.capacityFrames;
        this.count = need;
      }
    } else if (this.count < n) {
      this.primed = false;
      return this.silence(outLeft, outRight);
    }
    const cap = this.capacityFrames;
    let done = 0;
    while (done < n) {
      const run = Math.min(n - done, cap - this.head);
      outLeft.set(this.left.subarray(this.head, this.head + run), done);
      outRight.set(this.right.subarray(this.head, this.head + run), done);
      this.head = (this.head + run) % cap;
      done += run;
    }
    this.count -= n;
    return true;
  }

  private silence(outLeft: Float32Array, outRight: Float32Array): false {
    outLeft.fill(0);
    outRight.fill(0);
    return false;
  }
}
