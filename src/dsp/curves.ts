// Transfer curves for WaveShaperNode: a safety soft clipper and the fallback amp's drive.

/** Identity below `knee`, then bends smoothly towards (but never reaches) full scale. */
export function makeSoftClipCurve(samples = 2048, knee = 0.7): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const room = 1 - knee;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}

/** Tube-like saturation with a little asymmetry (adds even harmonics). Follow with a DC blocker. */
export function makeDriveCurve(samples = 4096, asymmetry = 0.15, hardness = 2.5): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(hardness * (1 + asymmetry));
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(hardness * (x + asymmetry * x * x)) / norm;
  }
  return curve;
}
