import { describe, expect, it } from 'vitest';
import { glideAt, glideHolds, type Glide } from './glide';

const run: Glide = { t0: 1000, x0: 0, v: -0.06, t1: 5000 };

describe('glideAt', () => {
  it('moves in a straight line from the start', () => {
    expect(glideAt(run, 1000)).toBe(0);
    expect(glideAt(run, 2000)).toBeCloseTo(-60);
  });

  it('stands still after the end of the run', () => {
    expect(glideAt(run, 9000)).toBeCloseTo(glideAt(run, 5000));
  });
});

describe('glideHolds', () => {
  it('holds while the lane is where the song is', () => {
    expect(glideHolds(run, -60.5, -0.06, 2000)).toBe(true);
  });

  it('breaks after a seek or a loop wrap', () => {
    expect(glideHolds(run, -62, -0.06, 2000)).toBe(false);
    expect(glideHolds(run, 300, -0.06, 2000)).toBe(false);
  });

  it('breaks when the speed or the lane width changes', () => {
    expect(glideHolds(run, -60, -0.05, 2000)).toBe(false);
  });

  it('breaks at the end of the run and without a glide', () => {
    expect(glideHolds(run, glideAt(run, 5000), -0.06, 5000)).toBe(false);
    expect(glideHolds(null, 0, -0.06, 2000)).toBe(false);
  });
});
