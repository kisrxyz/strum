import { describe, expect, it } from 'vitest';
import { ArrivalClock, TrackChunker, fromFrame, isSilent, toPcm16, type Chunk } from './clock';

describe('ArrivalClock', () => {
  it('finds the clock offset from the earliest arrivals', () => {
    const clock = new ArrivalClock(48000);
    expect(clock.moment(0)).toBeNull();
    // Frames of 480 every 10 ms; the engine's frame 0 was made at 1000 ms; each piece waits 1–9 ms.
    let seed = 7;
    const jitter = () => {
      seed = (seed * 16807) % 2147483647;
      return 1 + (seed / 2147483647) * 8;
    };
    for (let piece = 0; piece < 300; piece++) {
      const end = (piece + 1) * 480;
      clock.note(end, 1000 + (end * 1000) / 48000 + jitter());
    }
    // A frame 2 s in: within a ms of when it was made (the queues' smallest wait).
    const moment = clock.moment(96000)!;
    expect(moment).toBeGreaterThanOrEqual(3000);
    expect(moment).toBeLessThan(3001.2);
  });

  it('follows a clock that drifts and forgets old buckets', () => {
    const clock = new ArrivalClock(48000, 1000, 3);
    clock.note(48000, 2000); // offset 1000
    for (let t = 1; t <= 6; t++) clock.note(48000 * (t + 1), 2000 + 1000 * t + 5); // offset 1005, later
    expect(clock.moment(0)).toBe(1005);
  });
});

describe('toPcm16', () => {
  it('interleaves and clips', () => {
    const pcm = toPcm16([[Float32Array.of(0.5, 2), Float32Array.of(-1, -0.25)]], 2);
    expect(Array.from(pcm)).toEqual([16384, -32767, 32767, -8192]);
  });
});

describe('TrackChunker', () => {
  const block = (n: number, value = 0.5) => [new Float32Array(n).fill(value), new Float32Array(n).fill(-value)] as const;

  it('gathers blocks into chunks of the asked size', () => {
    const chunks: Chunk[] = [];
    const chunker = new TrackChunker(1000, (c) => chunks.push(c));
    for (let i = 0; i < 5; i++) chunker.push(i * 480, ...block(480));
    expect(chunks.map((c) => [c.at, c.frames])).toEqual([[0, 1440]]);
    chunker.flush();
    expect(chunks.map((c) => [c.at, c.frames])).toEqual([[0, 1440], [1440, 960]]);
    expect(chunks[0]!.data.length).toBe(2880);
  });

  it('starts a new chunk at a gap and skips frames already had', () => {
    const chunks: Chunk[] = [];
    const chunker = new TrackChunker(10_000, (c) => chunks.push(c));
    chunker.push(0, ...block(480));
    chunker.push(960, ...block(480)); // 480 frames lost
    chunker.push(1200, ...block(480)); // half of it repeats
    chunker.flush();
    expect(chunks.map((c) => [c.at, c.frames])).toEqual([[0, 480], [960, 720]]);
  });

  it('tells silence', () => {
    expect(isSilent(new Int16Array(8))).toBe(true);
    expect(isSilent(Int16Array.of(0, 0, 1, 0))).toBe(false);
  });
});

describe('fromFrame (the dry input starts where the guitar does)', () => {
  const ramp = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

  it('passes a block that starts at the frame or after it', () => {
    const left = ramp(4);
    const right = ramp(4, 10);
    expect(fromFrame(100, 100, left, right)).toEqual([100, left, right]);
    expect(fromFrame(100, 480, left, right)).toEqual([480, left, right]);
  });

  it('cuts off what lies before the frame', () => {
    const [frame, left, right] = fromFrame(102, 100, ramp(4), ramp(4, 10))!;
    expect(frame).toBe(102);
    expect([...left]).toEqual([2, 3]);
    expect([...right]).toEqual([12, 13]);
  });

  it('drops a block that ends before the frame', () => {
    expect(fromFrame(104, 100, ramp(4), ramp(4))).toBeNull();
    expect(fromFrame(960, 0, ramp(480), ramp(480))).toBeNull();
  });
});
