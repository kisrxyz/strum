// The WebSocket contract between the browser and the native guitar engine (kv_guitar).
// Text frames are JSON control messages, binary frames are audio. The other side of the same
// contract is service/src/kv_guitar/protocol.py: change both together (the tests share golden
// bytes).
//
// Binary frame (engine → browser), little-endian:
//
//   0   4 × u8        magic "KVG1"
//   4   u32           frames = n
//   8   f64           frame0: the engine's sample clock at the first frame
//   16  n × 2 × f32   the raw input, interleaved L, R, before the gate
//
// An output frame has the same layout with the magic "KVO1": what the card played for those frames
// (after the master and the soft clip). Only a browser that sent `record` on gets them («Запись»).

import type { ChannelChoice } from '../../dsp/channel';
import type { MainsHz } from '../../dsp/mains';
import type { Preset } from '../../state/presets';
import { isServiceMessage, messageText, type ServiceMessage } from '../../i18n/messages';

export const PROTOCOL_VERSION = 1;

export const FRAME_MAGIC = 'KVG1';
export const OUTPUT_MAGIC = 'KVO1';
export const FRAME_HEADER_BYTES = 16;
const BYTES_PER_FRAME = 8; // two float32
const MAGIC_U32_BE = 0x4b564731; // "KVG1"
const OUTPUT_U32_BE = 0x4b564f31; // "KVO1"

export type EngineBuffer = 32 | 64 | 128 | 256;

export interface ToneOffsets {
  bass: number;
  mid: number;
  treble: number;
}

export type ClientMessage =
  | { type: 'hello'; protocol: 1 }
  /** `device: null` — the first real card (not ASIO4ALL, FlexASIO, Realtek…), else the first one. */
  | { type: 'open'; device: string | null; buffer: EngineBuffer }
  /** The tab switched to «Браузер». */
  | { type: 'close' }
  | { type: 'preset'; preset: Preset; toneOffsets: ToneOffsets | null }
  | { type: 'master'; db: number; muted: boolean }
  | { type: 'channel'; choice: ChannelChoice }
  /** «Подстроить под мою гитару»: the input's own gain, dB, after the channel pick. */
  | { type: 'trim'; db: number }
  /** The mains the hum filter notches (src/dsp/mains.ts). An older engine ignores it. */
  | { type: 'mains'; hz: MainsHz }
  /** `data` is the file in base64, for `user:` ids. */
  | { type: 'asset'; id: string; kind: 'model' | 'ir'; data: string }
  /** «Запись»: send me what the card plays too (output frames), or stop. */
  | { type: 'record'; on: boolean };

export type EngineStatus = 'idle' | 'starting' | 'running' | 'error';
export type EngineAmpState = 'idle' | 'loading' | 'ready' | 'fallback';

export interface EngineState {
  type: 'state';
  protocol: 1;
  status: EngineStatus;
  devices: string[];
  device: string | null;
  sampleRate: number;
  buffer: number;
  /** From the driver (PortAudio stream latency). */
  latencyMs: { input: number; output: number } | null;
  /** `message` and `error` arrive as codes (src/i18n/messages.ts) and are turned into words here. */
  amp: { state: EngineAmpState; message?: string };
  error: string | null;
}

/** Sent at 10 Hz. Silence reads as −200 dB (JSON has no −Infinity). */
export interface EngineStats {
  type: 'stats';
  xruns: number;
  budgetMs: number;
  callbackMs: { p50: number; p99: number; max: number };
  outPeakDb: number;
  outRmsDb: number;
}

export type EngineMessage =
  | EngineState
  | EngineStats
  /** A preset names a `user:` id the engine does not have. */
  | { type: 'need-asset'; id: string };

export interface AudioFrame {
  /** `input`: the raw input (KVG1); `output`: what the card played (KVO1). */
  kind: 'input' | 'output';
  /** The engine's sample clock at the first frame (frames since the stream opened). */
  frame0: number;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}

function isFrameClock(frame0: number): boolean {
  return Number.isSafeInteger(frame0) && frame0 >= 0;
}

/** One audio frame from L, R, L, R… samples. `frame0` is a whole sample count (exact as f64 up to 2^53). */
export function encodeFrame(frame0: number, interleaved: Float32Array, kind: AudioFrame['kind'] = 'input'): ArrayBuffer {
  if (!isFrameClock(frame0)) throw new RangeError(`frame0 out of range: ${frame0}`);
  if (interleaved.length % 2 !== 0) throw new RangeError('expected interleaved stereo');
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + interleaved.length * 4);
  const view = new DataView(buf);
  view.setUint32(0, kind === 'input' ? MAGIC_U32_BE : OUTPUT_U32_BE, false);
  view.setUint32(4, interleaved.length / 2, true);
  view.setFloat64(8, frame0, true);
  for (let i = 0; i < interleaved.length; i++) {
    view.setFloat32(FRAME_HEADER_BYTES + i * 4, interleaved[i]!, true);
  }
  return buf;
}

/**
 * Reads an audio frame; null when the magic, the size or the clock is wrong.
 *
 * `left` and `right` are copies, each a fresh `Float32Array` with its own buffer: they stay
 * valid when `buf` is reused or changed, and may be transferred to a worklet. One frame is
 * 480 samples a channel every 10 ms, so the copy costs nothing next to the WebSocket itself.
 */
export function decodeFrame(buf: ArrayBuffer): AudioFrame | null {
  if (buf.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(buf);
  const magic = view.getUint32(0, false);
  if (magic !== MAGIC_U32_BE && magic !== OUTPUT_U32_BE) return null;
  const frames = view.getUint32(4, true);
  if (buf.byteLength !== FRAME_HEADER_BYTES + frames * BYTES_PER_FRAME) return null;
  const frame0 = view.getFloat64(8, true);
  if (!isFrameClock(frame0)) return null;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0, at = FRAME_HEADER_BYTES; i < frames; i++, at += BYTES_PER_FRAME) {
    left[i] = view.getFloat32(at, true);
    right[i] = view.getFloat32(at + 4, true);
  }
  return { kind: magic === MAGIC_U32_BE ? 'input' : 'output', frame0, frames, left, right };
}

// --- engine → browser ---

type Json = Record<string, unknown>;

const STATUSES: readonly EngineStatus[] = ['idle', 'starting', 'running', 'error'];
const AMP_STATES: readonly EngineAmpState[] = ['idle', 'loading', 'ready', 'fallback'];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** A message from the engine: a code with values, or (an older engine) a plain string. */
const isText = (x: unknown): x is string | ServiceMessage => typeof x === 'string' || isServiceMessage(x);

function parseState(raw: Json): EngineState | null {
  const { status, devices, device, sampleRate, buffer, latencyMs, amp, error } = raw;
  if (raw.protocol !== PROTOCOL_VERSION) return null;
  if (!isOneOf(status, STATUSES)) return null;
  if (!Array.isArray(devices) || !devices.every((d): d is string => typeof d === 'string')) return null;
  if (device !== null && typeof device !== 'string') return null;
  if (!isNumber(sampleRate) || !isNumber(buffer)) return null;
  let latency: EngineState['latencyMs'] = null;
  if (latencyMs !== null) {
    if (!isObject(latencyMs) || !isNumber(latencyMs.input) || !isNumber(latencyMs.output)) return null;
    latency = { input: latencyMs.input, output: latencyMs.output };
  }
  if (!isObject(amp) || !isOneOf(amp.state, AMP_STATES)) return null;
  if (amp.message !== undefined && !isText(amp.message)) return null;
  if (error !== null && !isText(error)) return null;
  return {
    type: 'state',
    protocol: PROTOCOL_VERSION,
    status,
    devices: [...devices],
    device,
    sampleRate,
    buffer,
    latencyMs: latency,
    amp: amp.message === undefined ? { state: amp.state } : { state: amp.state, message: messageText(amp.message) },
    error: error === null ? null : messageText(error),
  };
}

function parseStats(raw: Json): EngineStats | null {
  const { xruns, budgetMs, callbackMs, outPeakDb, outRmsDb } = raw;
  if (!isNumber(xruns) || !isNumber(budgetMs) || !isNumber(outPeakDb) || !isNumber(outRmsDb)) return null;
  if (!isObject(callbackMs)) return null;
  const { p50, p99, max } = callbackMs;
  if (!isNumber(p50) || !isNumber(p99) || !isNumber(max)) return null;
  return { type: 'stats', xruns, budgetMs, callbackMs: { p50, p99, max }, outPeakDb, outRmsDb };
}

/**
 * A checked message from the engine; null for anything else (not JSON, an unknown `type`,
 * a missing field or one of the wrong type). Fields the contract does not name are dropped.
 */
export function parseEngineMessage(text: string): EngineMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case 'state':
      return parseState(raw);
    case 'stats':
      return parseStats(raw);
    case 'need-asset':
      return typeof raw.id === 'string' && raw.id !== '' ? { type: 'need-asset', id: raw.id } : null;
    default:
      return null;
  }
}
