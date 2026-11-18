// Waveform columns from the service's peaks (int8 min/max pairs, `perSecond` per second).

/** `columns` min/max pairs in -1..1 for the first `duration` seconds. */
export function peakColumns(peaks: Int8Array, perSecond: number, columns: number, duration: number): Float32Array {
  const out = new Float32Array(columns * 2);
  const bins = Math.floor(peaks.length / 2);
  const binsShown = duration * perSecond;
  for (let c = 0; c < columns; c++) {
    const from = Math.min(bins - 1, Math.floor((c / columns) * binsShown));
    const to = Math.min(bins, Math.max(from + 1, Math.floor(((c + 1) / columns) * binsShown)));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i++) {
      lo = Math.min(lo, peaks[2 * i]);
      hi = Math.max(hi, peaks[2 * i + 1]);
    }
    out[2 * c] = lo / 127;
    out[2 * c + 1] = hi / 127;
  }
  return out;
}
