// WAV in and out: the browser sends the decoded song to the service as a float WAV, and a dropped
// WAV is told apart (song or cabinet) by the length in its header.

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
}

const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** Interleaved 32-bit float WAV (format 3), little-endian. */
export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_FLOAT, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 4, true);
  view.setUint16(32, count * 4, true);
  view.setUint16(34, 32, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  const samples = new Float32Array(buffer, 44, frames * count);
  for (let c = 0; c < count; c++) {
    const channel = channels[c];
    for (let i = 0; i < frames; i++) samples[i * count + c] = channel[i];
  }
  return buffer;
}

/** Format and length from the first bytes of a WAV file; null if it is not one. */
export function readWavInfo(head: Uint8Array, fileSize: number): WavInfo | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (head.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let fmt: { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  let at = 12;
  while (at + 8 <= head.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 24 <= head.length) {
      fmt = {
        format: view.getUint16(at + 8, true),
        channels: view.getUint16(at + 10, true),
        sampleRate: view.getUint32(at + 12, true),
        blockAlign: view.getUint16(at + 20, true),
        bits: view.getUint16(at + 22, true),
      };
      if (fmt.format === FORMAT_EXTENSIBLE && at + 34 <= head.length) fmt.format = view.getUint16(at + 32, true);
    }
    if (id === 'data') {
      dataOffset = at + 8;
      dataSize = size;
      break;
    }
    at += 8 + size + (size % 2); // chunks are padded to an even size
  }
  if (!fmt || !fmt.sampleRate || !fmt.channels) return null;

  const start = dataOffset >= 0 ? dataOffset : at;
  const sizeIsReal = dataOffset >= 0 && dataSize > 0 && dataSize !== 0xffffffff && start + dataSize <= fileSize;
  const bytes = sizeIsReal ? dataSize : Math.max(0, fileSize - start);
  const frameBytes = fmt.blockAlign || (fmt.channels * fmt.bits) / 8;
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    durationSeconds: bytes / frameBytes / fmt.sampleRate,
  };
}
