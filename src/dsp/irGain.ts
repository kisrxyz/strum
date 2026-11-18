// Cabinet IR gain staging: scale the kernel so its mean power response over the guitar band
// (100 Hz – 5 kHz, log-spaced) is 0 dB. Then every cabinet keeps the amp at the same loudness.
// Same convention as the TONE3000 player; the ConvolverNode's own normalisation is switched off.

const BAND_LO_HZ = 100;
const BAND_HI_HZ = 5000;
const BAND_POINTS = 64;
const MAX_BOOST_DB = 24;
const MAX_CUT_DB = 48;

export function irInBandGainDb(taps: Float32Array, sampleRate: number): number {
  let acc = 0;
  for (let k = 0; k < BAND_POINTS; k++) {
    const f = BAND_LO_HZ * (BAND_HI_HZ / BAND_LO_HZ) ** (k / (BAND_POINTS - 1));
    const w = (2 * Math.PI * f) / sampleRate;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    // cos(w·i), sin(w·i) by rotation: no trig per tap.
    let c = 1;
    let s = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < taps.length; i++) {
      re += taps[i] * c;
      im += taps[i] * s;
      const next = c * cw - s * sw;
      s = s * cw + c * sw;
      c = next;
    }
    acc += re * re + im * im;
  }
  const meanPower = acc / BAND_POINTS;
  if (!(meanPower > 0) || !Number.isFinite(meanPower)) return 0;
  return Math.min(MAX_BOOST_DB, Math.max(-MAX_CUT_DB, -10 * Math.log10(meanPower)));
}
