// «Запись»: copies what passes through it to the main thread, about 20 ms at a time, with the
// context frame of the first sample. No outputs (Chrome runs a worklet without outputs while
// something is connected to it). A missing input is sent as silence, so the timeline has no holes.

// The name `src/record/tap.ts` creates it by.
const TAP_PROCESSOR = 'kv-tap';

const BATCH = 1024;

class TapProcessor extends AudioWorkletProcessor {
  private left = new Float32Array(BATCH);
  private right = new Float32Array(BATCH);
  private filled = 0;
  private first = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const l = input?.[0];
    const r = input?.[1] ?? l;
    const n = l?.length ?? 128;
    if (this.filled + n > BATCH) this.send();
    if (this.filled === 0) this.first = currentFrame;
    if (l && r) {
      this.left.set(l, this.filled);
      this.right.set(r, this.filled);
    }
    this.filled += n; // the fresh arrays are zeros: a missing input stays silence
    if (this.filled >= BATCH) this.send();
    return true;
  }

  private send(): void {
    if (!this.filled) return;
    const left = this.filled === BATCH ? this.left : this.left.slice(0, this.filled);
    const right = this.filled === BATCH ? this.right : this.right.slice(0, this.filled);
    this.port.postMessage({ frame: this.first, left, right }, [left.buffer, right.buffer]);
    this.left = new Float32Array(BATCH);
    this.right = new Float32Array(BATCH);
    this.filled = 0;
  }
}

registerProcessor(TAP_PROCESSOR, TapProcessor);
