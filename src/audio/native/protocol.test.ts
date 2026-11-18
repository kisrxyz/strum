import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESETS } from '../../state/presets';
import type { ClientMessage, EngineMessage, EngineState, EngineStats } from './protocol';
import {
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  parseEngineMessage,
  PROTOCOL_VERSION,
} from './protocol';

// frame0 = 96 000, 3 frames, L = [0.5, -0.25, 0], R = [1, 0, -1]. The same bytes are in
// service/tests/test_guitar_protocol.py.
const GOLDEN_HEX =
  '4b564731' + '03000000' + '000000000070f740' + '0000003f' + '0000803f' + '000080be' + '00000000' + '00000000' + '000080bf';
const GOLDEN_INTERLEAVED = new Float32Array([0.5, 1, -0.25, 0, 0, -1]);

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): ArrayBuffer {
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

// The same message is built in service/tests/test_guitar_protocol.py.
const STATE: EngineState = {
  type: 'state',
  protocol: 1,
  status: 'running',
  devices: ['M-Track Solo and Duo ASIO', 'ASIO4ALL v2'],
  device: 'M-Track Solo and Duo ASIO',
  sampleRate: 48000,
  buffer: 64,
  latencyMs: { input: 2.5, output: 3.25 },
  amp: { state: 'fallback', message: 'Запусти npm run setup' },
  error: null,
};

const STATS: EngineStats = {
  type: 'stats',
  xruns: 2,
  budgetMs: 1.333,
  callbackMs: { p50: 0.4, p99: 0.9, max: 1.2 },
  outPeakDb: -6,
  outRmsDb: -18.5,
};

function parse(message: unknown): EngineMessage | null {
  return parseEngineMessage(JSON.stringify(message));
}

describe('the audio frame', () => {
  it('has the contract constants', () => {
    expect(FRAME_MAGIC).toBe('KVG1');
    expect(FRAME_HEADER_BYTES).toBe(16);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('encodes the golden bytes', () => {
    expect(hex(encodeFrame(96_000, GOLDEN_INTERLEAVED))).toBe(GOLDEN_HEX);
  });

  it('encodes a view into a bigger buffer', () => {
    const big = new Float32Array(10);
    big.set(GOLDEN_INTERLEAVED, 2);
    expect(hex(encodeFrame(96_000, big.subarray(2, 8)))).toBe(GOLDEN_HEX);
  });

  it('refuses an odd sample count and a bad clock', () => {
    expect(() => encodeFrame(0, new Float32Array(5))).toThrow(RangeError);
    expect(() => encodeFrame(-1, new Float32Array(2))).toThrow(RangeError);
    expect(() => encodeFrame(0.5, new Float32Array(2))).toThrow(RangeError);
    expect(() => encodeFrame(Number.NaN, new Float32Array(2))).toThrow(RangeError);
  });

  it('tells an output frame by its magic alone', () => {
    const output = encodeFrame(96_000, GOLDEN_INTERLEAVED, 'output');
    expect(hex(output)).toBe('4b564f31' + GOLDEN_HEX.slice(8));
    const frame = decodeFrame(output)!;
    expect(frame.kind).toBe('output');
    expect(frame.frame0).toBe(96_000);
    expect(Array.from(frame.right)).toEqual([1, 0, -1]);
  });

  it('decodes the golden bytes', () => {
    const frame = decodeFrame(fromHex(GOLDEN_HEX));
    expect(frame).not.toBeNull();
    expect(frame!.kind).toBe('input');
    expect(frame!.frame0).toBe(96_000);
    expect(frame!.frames).toBe(3);
    expect(Array.from(frame!.left)).toEqual([0.5, -0.25, 0]);
    expect(Array.from(frame!.right)).toEqual([1, 0, -1]);
  });

  it('round-trips a frame of the real size', () => {
    const block = new Float32Array(960);
    for (let i = 0; i < block.length; i++) block[i] = Math.sin(i * 0.37);
    const frame0 = 2 ** 40 + 480;
    const buf = encodeFrame(frame0, block);
    expect(buf.byteLength).toBe(16 + 3840);
    const frame = decodeFrame(buf)!;
    expect(frame.frame0).toBe(frame0);
    expect(frame.frames).toBe(480);
    for (let i = 0; i < 480; i++) {
      expect(frame.left[i]).toBe(block[i * 2]);
      expect(frame.right[i]).toBe(block[i * 2 + 1]);
    }
  });

  it('round-trips an empty frame', () => {
    const frame = decodeFrame(encodeFrame(7, new Float32Array(0)))!;
    expect(frame.frame0).toBe(7);
    expect(frame.frames).toBe(0);
    expect(frame.left.length).toBe(0);
    expect(frame.right.length).toBe(0);
  });

  it('gives copies that outlive the input buffer', () => {
    const buf = fromHex(GOLDEN_HEX);
    const frame = decodeFrame(buf)!;
    new Uint8Array(buf).fill(0xff);
    expect(Array.from(frame.left)).toEqual([0.5, -0.25, 0]);
    expect(Array.from(frame.right)).toEqual([1, 0, -1]);
    expect(frame.left).toBeInstanceOf(Float32Array);
    expect(frame.left.buffer).not.toBe(buf);
    expect(frame.left.buffer).not.toBe(frame.right.buffer);
  });

  it('rejects a wrong magic', () => {
    expect(decodeFrame(fromHex('4b564732' + GOLDEN_HEX.slice(8)))).toBeNull();
  });

  it('rejects a truncated frame', () => {
    const golden = fromHex(GOLDEN_HEX);
    for (const size of [0, 3, 15, 16, golden.byteLength - 1]) {
      expect(decodeFrame(golden.slice(0, size))).toBeNull();
    }
  });

  it('rejects extra bytes', () => {
    expect(decodeFrame(fromHex(GOLDEN_HEX + '00000000'))).toBeNull();
  });

  it('rejects a bad clock', () => {
    for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      const buf = fromHex(GOLDEN_HEX);
      new DataView(buf).setFloat64(8, clock, true);
      expect(decodeFrame(buf)).toBeNull();
    }
  });
});

describe('parseEngineMessage', () => {
  it('reads a state message', () => {
    expect(parse(STATE)).toEqual(STATE);
  });

  it('reads the text the Python side writes', () => {
    // json.dumps style: spaces after the separators, null for None.
    const text =
      '{"type": "state", "protocol": 1, "status": "idle", "devices": [], "device": null, ' +
      '"sampleRate": 48000, "buffer": 0, "latencyMs": null, "amp": {"state": "idle"}, "error": null}';
    expect(parseEngineMessage(text)).toEqual({
      type: 'state',
      protocol: 1,
      status: 'idle',
      devices: [],
      device: null,
      sampleRate: 48000,
      buffer: 0,
      latencyMs: null,
      amp: { state: 'idle' },
      error: null,
    });
  });

  it('reads every status and amp state', () => {
    for (const status of ['idle', 'starting', 'running', 'error']) {
      expect(parse({ ...STATE, status })).toEqual({ ...STATE, status });
    }
    for (const state of ['idle', 'loading', 'ready', 'fallback']) {
      expect(parse({ ...STATE, amp: { state } })).toEqual({ ...STATE, amp: { state } });
    }
    expect(parse({ ...STATE, status: 'error', error: 'Карта не открылась' })).toEqual({
      ...STATE,
      status: 'error',
      error: 'Карта не открылась',
    });
  });

  it('turns the engine messages into words', () => {
    const state = parse({
      ...STATE,
      status: 'error',
      error: { code: 'requestFailed', params: { status: 7 } },
      amp: { state: 'fallback', message: { code: 'nope' } },
    }) as EngineState;
    expect(state.error).toContain('7');
    expect(state.amp.message).toContain('nope');
    expect(parse({ ...STATE, error: { text: 'not a message' } })).toBeNull();
  });

  it('reads stats and need-asset', () => {
    expect(parse(STATS)).toEqual(STATS);
    expect(parse({ type: 'need-asset', id: 'user:1b2c' })).toEqual({ type: 'need-asset', id: 'user:1b2c' });
  });

  it('drops fields it does not know', () => {
    expect(parse({ ...STATE, junk: 1, amp: { ...STATE.amp, junk: 2 } })).toEqual(STATE);
    expect(parse({ ...STATS, junk: 1 })).toEqual(STATS);
  });

  it('rejects what is not a message', () => {
    for (const text of ['', 'not json', '{', '[]', 'null', '1', '"state"', '{}', '{"type":1}', '{"type":"nope"}']) {
      expect(parseEngineMessage(text)).toBeNull();
    }
    // A client message is not an engine message.
    expect(parse({ type: 'hello', protocol: 1 })).toBeNull();
  });

  it('rejects a malformed state', () => {
    const bad: unknown[] = [
      { ...STATE, protocol: 2 },
      { ...STATE, protocol: undefined },
      { ...STATE, status: 'paused' },
      { ...STATE, devices: 'M-Track' },
      { ...STATE, devices: ['a', 1] },
      { ...STATE, device: 3 },
      { ...STATE, device: undefined },
      { ...STATE, sampleRate: '48000' },
      { ...STATE, buffer: null },
      { ...STATE, latencyMs: 5 },
      { ...STATE, latencyMs: { input: 2.5 } },
      { ...STATE, latencyMs: { input: '2.5', output: 3 } },
      { ...STATE, latencyMs: undefined },
      { ...STATE, amp: null },
      { ...STATE, amp: { state: 'broken' } },
      { ...STATE, amp: { state: 'ready', message: 5 } },
      { ...STATE, error: 5 },
      { ...STATE, error: undefined },
    ];
    for (const message of bad) expect(parse(message), JSON.stringify(message)).toBeNull();
  });

  it('rejects malformed stats and need-asset', () => {
    const bad: unknown[] = [
      { ...STATS, xruns: '2' },
      { ...STATS, budgetMs: null },
      { ...STATS, callbackMs: null },
      { ...STATS, callbackMs: { p50: 0.4, p99: 0.9 } },
      { ...STATS, callbackMs: { p50: 0.4, p99: 0.9, max: '1' } },
      { ...STATS, outPeakDb: null },
      { ...STATS, outRmsDb: undefined },
      { type: 'need-asset' },
      { type: 'need-asset', id: 5 },
      { type: 'need-asset', id: '' },
    ];
    for (const message of bad) expect(parse(message), JSON.stringify(message)).toBeNull();
  });
});

describe('ClientMessage', () => {
  it('covers every contract variant', () => {
    // A compile-time check (npm run typecheck) more than a run-time one.
    const messages: ClientMessage[] = [
      { type: 'hello', protocol: 1 },
      { type: 'open', device: null, buffer: 64 },
      { type: 'open', device: 'M-Track Solo and Duo ASIO', buffer: 256 },
      { type: 'close' },
      { type: 'preset', preset: DEFAULT_PRESETS[0]!, toneOffsets: null },
      { type: 'preset', preset: DEFAULT_PRESETS[1]!, toneOffsets: { bass: 1, mid: 0, treble: -1 } },
      { type: 'master', db: -6, muted: false },
      { type: 'channel', choice: 'right' },
      { type: 'asset', id: 'user:1b2c', kind: 'ir', data: 'AAAA' },
    ];
    expect(new Set(messages.map((m) => m.type)).size).toBe(7);
  });
});
