// The song service's loudness and waveform peaks (service/src/kv_service/audio.py), for audio the
// app renders itself: a tab-song has no mix on the service.

const SILENCE_DB = -70;

/**
 * Average loudness in dB: mean square over 400 ms blocks of both channels, quiet blocks left out
 * (under −60 dBFS, then more than 20 dB below the average of the rest). `loudness_db` in audio.py.
 */
export function loudnessDb(left: Float32Array, right: Float32Array, rate: number): number {
  return stemsLoudnessDb([left, right], rate);
}

/**
 * `loudnessDb` of the sum of several stereo pairs ([left, right, left, right…], all as long as the
 * first): the stems of a tab-song, summed on the fly (no mix is allocated).
 */
export function stemsLoudnessDb(channels: Float32Array[], rate: number): number {
  const length = channels[0]?.length ?? 0;
  const block = Math.max(1, Math.round(0.4 * rate));
  const count = Math.max(1, Math.floor(length / block));
  const blocks: number[] = [];
  for (let b = 0; b < count; b++) {
    let sum = 0;
    const from = b * block;
    const to = Math.min(length, from + block);
    for (let i = from; i < to; i++) {
      let l = 0;
      let r = 0;
      for (let c = 0; c + 1 < channels.length; c += 2) {
        l += channels[c][i];
        r += channels[c + 1][i];
      }
      sum += l * l + r * r;
    }
    blocks.push(to > from ? sum / (2 * (to - from)) : 0);
  }
  let kept = blocks.filter((x) => x > 10 ** (-60 / 10));
  if (!kept.length) return SILENCE_DB;
  const mean = kept.reduce((s, x) => s + x, 0) / kept.length;
  kept = kept.filter((x) => x > mean * 10 ** (-20 / 10));
  const loud = kept.reduce((s, x) => s + x, 0) / kept.length;
  return Math.max(SILENCE_DB, 10 * Math.log10(loud));
}

/** True for a SoundFont (SF2 or SF3: a RIFF file of form «sfbk»). A missing file comes back as the app's page. */
export function isSoundFont(bytes: Uint8Array): boolean {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  return bytes.length > 12 && tag(0) === 'RIFF' && tag(8) === 'sfbk';
}

/** Waveform for drawing: min and max of the mono mix per 1/perSecond s, as int8 pairs. `peaks_int8`. */
export function peaksInt8(left: Float32Array, right: Float32Array, rate: number, perSecond = 100): Int8Array {
  return mixPeaks([left, right], rate, perSecond);
}

/**
 * `peaksInt8` of the sum of several stereo pairs ([left, right, left, right…], all as long as
 * the first), summed on the fly: no mix is allocated.
 */
export function mixPeaks(channels: Float32Array[], rate: number, perSecond = 100): Int8Array {
  const length = channels[0]?.length ?? 0;
  const size = Math.max(1, Math.floor(rate / perSecond));
  const bins = Math.max(1, Math.ceil(length / size));
  const out = new Int8Array(2 * bins);
  const clip = (x: number) => Math.round(Math.min(1, Math.max(-1, x)) * 127);
  // One bin at a time, channel after channel: each sample is read once, in order.
  const mix = new Float32Array(size);
  for (let b = 0; b < bins; b++) {
    const from = b * size;
    const n = Math.min(length, from + size) - from;
    mix.fill(0);
    for (let c = 0; c < channels.length; c++) {
      const channel = channels[c];
      for (let k = 0; k < n; k++) mix[k] += channel[from + k];
    }
    // The last bin is padded with silence, as in audio.py.
    let lo = n < size ? 0 : Infinity;
    let hi = n < size ? 0 : -Infinity;
    for (let k = 0; k < n; k++) {
      const m = mix[k] / 2;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    out[2 * b] = clip(lo);
    out[2 * b + 1] = clip(hi);
  }
  return out;
}
