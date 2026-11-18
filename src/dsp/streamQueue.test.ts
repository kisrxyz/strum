import { describe, expect, it } from 'vitest';
import { StreamQueue } from './streamQueue';

/** n samples counting up from `from` (the right channel gets the negative). */
function ramp(from: number, n: number): [Float32Array, Float32Array] {
  const left = Float32Array.from({ length: n }, (_, i) => from + i);
  const right = Float32Array.from({ length: n }, (_, i) => -(from + i));
  return [left, right];
}

function pull(queue: StreamQueue, n: number): { ok: boolean; left: Float32Array; right: Float32Array } {
  // Pre-filled with junk: a pull that "fills with zeros" must overwrite it.
  const left = new Float32Array(n).fill(7);
  const right = new Float32Array(n).fill(7);
  return { ok: queue.pull(left, right), left, right };
}

describe('StreamQueue', () => {
  it('plays pushed audio after the target fill', () => {
    const queue = new StreamQueue(1000, 100);
    queue.push(...ramp(0, 60));
    const early = pull(queue, 32);
    expect(early.ok).toBe(false); // still under the target: the cushion is being built
    expect(early.left.every((x) => x === 0)).toBe(true);
    expect(queue.fill).toBe(60); // nothing was consumed

    queue.push(...ramp(60, 40)); // exactly the target now
    const first = pull(queue, 32);
    expect(first.ok).toBe(true);
    expect(Array.from(first.left)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(Array.from(first.right)).toEqual(Array.from({ length: 32 }, (_, i) => -i));
    const second = pull(queue, 32);
    expect(second.ok).toBe(true);
    expect(second.left[0]).toBe(32);
    expect(queue.fill).toBe(100 - 64);
  });

  it('after an underrun, a burst of backlog starts playing from the newest target, not from the oldest', () => {
    const queue = new StreamQueue(1000, 100);
    queue.push(...ramp(0, 100));
    for (let i = 0; i < 4; i++) pull(queue, 32); // 96 played, then an underrun
    expect(pull(queue, 32).ok).toBe(false);
    queue.push(...ramp(500, 400)); // a main-thread stall ends: 400 frames arrive at once
    const block = pull(queue, 32);
    expect(block.ok).toBe(true);
    expect(block.left[0]).toBe(500 + 400 - 100); // the lag is the target again
    expect(queue.fill).toBe(100 - 32);
  });

  it('a stall does not raise the lag for good: the fill goes back to the target', () => {
    const queue = new StreamQueue(1000, 100);
    let next = 0;
    const round = () => {
      queue.push(...ramp(next, 48));
      next += 48;
      pull(queue, 24);
      pull(queue, 24);
    };
    for (let i = 0; i < 20; i++) round();
    // 12 rounds without a push (the main thread is stuck): the worklet runs dry…
    for (let i = 0; i < 12; i++) pull(queue, 24);
    // …then everything that piled up in the browser arrives in one go.
    queue.push(...ramp(next, 12 * 48));
    next += 12 * 48;
    for (let i = 0; i < 40; i++) {
      round();
      expect(queue.fill).toBeLessThanOrEqual(100);
    }
  });

  it('underrun returns false and zeros', () => {
    const queue = new StreamQueue(1000, 64);
    queue.push(...ramp(0, 64));
    expect(pull(queue, 32).ok).toBe(true);
    expect(pull(queue, 32).ok).toBe(true);
    const empty = pull(queue, 32);
    expect(empty.ok).toBe(false);
    expect(empty.left.every((x) => x === 0)).toBe(true);
    expect(empty.right.every((x) => x === 0)).toBe(true);
  });

  it('rebuilds the cushion after an underrun before playing again', () => {
    const queue = new StreamQueue(1000, 64);
    queue.push(...ramp(0, 64));
    pull(queue, 32);
    pull(queue, 32);
    expect(pull(queue, 32).ok).toBe(false); // underrun
    queue.push(...ramp(64, 32)); // enough for a block, under the target
    expect(pull(queue, 32).ok).toBe(false);
    queue.push(...ramp(96, 32));
    const back = pull(queue, 32);
    expect(back.ok).toBe(true);
    expect(back.left[0]).toBe(64);
  });

  it('does not play half a block: a block that cannot be filled is an underrun', () => {
    const queue = new StreamQueue(1000, 10);
    queue.push(...ramp(0, 20));
    const block = pull(queue, 32);
    expect(block.ok).toBe(false);
    expect(block.left.every((x) => x === 0)).toBe(true);
  });

  it('StreamQueue drops the oldest audio above the cap', () => {
    const queue = new StreamQueue(100, 20);
    queue.push(...ramp(0, 80));
    queue.push(...ramp(80, 60)); // 140 in all: over the cap
    expect(queue.fill).toBeLessThanOrEqual(100);

    const got: number[] = [];
    for (;;) {
      const block = pull(queue, 10);
      if (!block.ok) break;
      got.push(...block.left);
    }
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]).toBeGreaterThan(0); // the oldest samples are gone…
    expect(got[got.length - 1]).toBe(139); // …the newest one stays
    // What is left is one unbroken run: nothing is reordered or skipped inside it.
    for (let i = 1; i < got.length; i++) expect(got[i]).toBe(got[i - 1]! + 1);
  });

  it('an overflow lets the lag fall back to the target, not stay at the cap', () => {
    // A card clock a little faster than the browser's fills the queue for good; keeping it
    // pinned at the cap would hold 200 ms of lag for the rest of the session.
    const queue = new StreamQueue(1000, 100);
    queue.push(...ramp(0, 900));
    queue.push(...ramp(900, 480)); // over the cap
    expect(queue.fill).toBeLessThan(1000);
    expect(queue.fill).toBeGreaterThanOrEqual(480);
    expect(queue.fill).toBeLessThanOrEqual(500);
  });

  it('keeps only the newest part of one chunk bigger than the cap', () => {
    const queue = new StreamQueue(100, 20);
    queue.push(...ramp(0, 250));
    expect(queue.fill).toBe(100);
    const block = pull(queue, 100);
    expect(block.ok).toBe(true);
    expect(block.left[0]).toBe(150);
    expect(block.left[99]).toBe(249);
  });

  it('reads back an unbroken stream through the wrap-around of the ring', () => {
    const queue = new StreamQueue(300, 48);
    let next = 0;
    let want = 0;
    for (let round = 0; round < 200; round++) {
      queue.push(...ramp(next, 48)); // not a divisor of the capacity: the write position wraps at odd places
      next += 48;
      for (let part = 0; part < 2; part++) {
        const block = pull(queue, 24);
        expect(block.ok).toBe(true);
        for (let i = 0; i < 24; i++) {
          expect(block.left[i]).toBe(want + i);
          expect(block.right[i]).toBe(-(want + i));
        }
        want += 24;
      }
    }
    expect(want).toBe(200 * 48);
  });

  it('ignores the part of a push that has no partner in the other channel', () => {
    const queue = new StreamQueue(100, 4);
    queue.push(new Float32Array([1, 2, 3, 4, 5]), new Float32Array([1, 2, 3]));
    expect(queue.fill).toBe(3);
  });

  it('rejects a target bigger than the capacity', () => {
    expect(() => new StreamQueue(10, 11)).toThrow(RangeError);
    expect(() => new StreamQueue(0, 0)).toThrow(RangeError);
  });
});
