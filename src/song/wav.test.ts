import { describe, expect, it } from 'vitest';
import { encodeWavFloat32, readWavInfo } from './wav';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

describe('encodeWavFloat32', () => {
  it('writes a float stereo WAV with interleaved samples', () => {
    const left = Float32Array.from([0.5, -0.25]);
    const right = Float32Array.from([1, 0]);
    const bytes = new Uint8Array(encodeWavFloat32([left, right], 44100));
    expect(bytes.length).toBe(44 + 2 * 2 * 4);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(3); // IEEE float
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(Array.from(new Float32Array(bytes.buffer, 44))).toEqual([0.5, 1, -0.25, 0]);
  });
});

describe('readWavInfo', () => {
  it('reads back what encodeWavFloat32 wrote', () => {
    const frames = 44100 * 3;
    const wav = new Uint8Array(encodeWavFloat32([new Float32Array(frames), new Float32Array(frames)], 44100));
    expect(readWavInfo(wav.subarray(0, 64), wav.length)).toEqual({
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 32,
      durationSeconds: 3,
    });
  });

  it('reads a WAVE_FORMAT_EXTENSIBLE header with a LIST chunk before the data', () => {
    const dataBytes = 48000 * 6 * 25; // 25 s of 24-bit stereo
    const head = Uint8Array.from([
      ...ascii('RIFF'), ...u32(4 + 48 + 12 + 8 + dataBytes), ...ascii('WAVE'),
      ...ascii('fmt '), ...u32(40), ...u16(0xfffe), ...u16(2), ...u32(48000), ...u32(48000 * 6), ...u16(6), ...u16(24),
      ...u16(22), ...u16(24), ...u32(3), ...u16(1), ...new Array(14).fill(0),
      ...ascii('LIST'), ...u32(4), ...ascii('INFO'),
      ...ascii('data'), ...u32(dataBytes),
    ]);
    const info = readWavInfo(head, head.length + dataBytes);
    expect(info).toMatchObject({ sampleRate: 48000, channels: 2, bitsPerSample: 24 });
    expect(info?.durationSeconds).toBeCloseTo(25, 6);
  });

  it('falls back to the file size when the data size is bogus (streamed WAVs)', () => {
    const wav = new Uint8Array(encodeWavFloat32([new Float32Array(44100), new Float32Array(44100)], 44100));
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(readWavInfo(wav.subarray(0, 64), wav.length)?.durationSeconds).toBeCloseTo(1, 6);
  });

  it('is null for files that are not WAV', () => {
    expect(readWavInfo(Uint8Array.from([...ascii('ID3'), 4, 0, 0, 0, 0, 0, 0, 0, 0]), 1000)).toBeNull();
    expect(readWavInfo(Uint8Array.from(ascii('RIFF')), 4)).toBeNull();
  });
});
