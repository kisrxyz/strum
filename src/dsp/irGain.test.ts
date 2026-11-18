import { describe, expect, it } from 'vitest';
import { irInBandGainDb } from './irGain';

const SR = 48000;

function impulse(amp: number, length = 256): Float32Array {
  const taps = new Float32Array(length);
  taps[0] = amp;
  return taps;
}

describe('irInBandGainDb', () => {
  it('leaves a unit impulse (flat response) alone', () => {
    expect(irInBandGainDb(impulse(1), SR)).toBeCloseTo(0, 6);
  });

  it('brings a quieter cabinet up to unity in the guitar band', () => {
    expect(irInBandGainDb(impulse(0.5), SR)).toBeCloseTo(6.02, 2);
  });

  it('does not boost a nearly silent file by more than +24 dB', () => {
    expect(irInBandGainDb(impulse(1e-4), SR)).toBe(24);
  });

  it('cuts a very loud IR by at most 48 dB', () => {
    expect(irInBandGainDb(impulse(1e4), SR)).toBe(-48);
  });

  it('treats an empty IR as unity', () => {
    expect(irInBandGainDb(new Float32Array(64), SR)).toBe(0);
  });
});
