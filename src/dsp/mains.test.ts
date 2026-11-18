import { describe, expect, it } from 'vitest';
import { MainsDetector, mainsVote } from './mains';

const RATE = 48000;

/** Half a second of hum on `hz` and three harmonics, with hiss, at about −60 dBFS. */
function hum(hz: number, hissDb = -75, seed = 1): Float32Array {
  const x = new Float32Array(RATE / 2);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const hiss = 10 ** (hissDb / 20);
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    x[i] =
      0.0008 * Math.sin(2 * Math.PI * hz * t) +
      0.0006 * Math.sin(2 * Math.PI * 2 * hz * t + 1) +
      0.0009 * Math.sin(2 * Math.PI * 3 * hz * t + 2) +
      0.0003 * Math.sin(2 * Math.PI * 4 * hz * t) +
      hiss * rand();
  }
  return x;
}

function tone(hz: number, amp: number): Float32Array {
  const x = new Float32Array(RATE / 2);
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return x;
}

function noise(db: number, seed = 7): Float32Array {
  const x = new Float32Array(RATE / 2);
  let s = seed;
  for (let i = 0; i < x.length; i++) x[i] = 10 ** (db / 20) * (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
  return x;
}

describe('mainsVote', () => {
  it('hears 50 Hz hum and 60 Hz hum', () => {
    expect(mainsVote(hum(50), RATE)).toBe(50);
    expect(mainsVote(hum(60), RATE)).toBe(60);
  });

  it('still hears it with the mains a little off', () => {
    expect(mainsVote(hum(50.1), RATE)).toBe(50);
    expect(mainsVote(hum(59.9), RATE)).toBe(60);
  });

  it('says nothing for hiss alone', () => {
    expect(mainsVote(noise(-60), RATE)).toBeNull();
  });

  it('says nothing while a note plays (the window is not quiet)', () => {
    const x = hum(50);
    const note = tone(110, 0.1);
    for (let i = 0; i < x.length; i++) x[i] += note[i];
    expect(mainsVote(x, RATE)).toBeNull();
  });

  it('says nothing for digital silence', () => {
    expect(mainsVote(new Float32Array(RATE / 2), RATE)).toBeNull();
  });
});

describe('MainsDetector', () => {
  it('decides after three agreeing quiet windows', () => {
    const d = new MainsDetector();
    expect(d.push(hum(60, -75, 1), RATE)).toBeNull();
    expect(d.push(hum(60, -75, 2), RATE)).toBeNull();
    expect(d.push(hum(60, -75, 3), RATE)).toBe(60);
  });

  it('starts over when a window disagrees, and ignores windows with no vote', () => {
    const d = new MainsDetector();
    d.push(hum(50), RATE);
    d.push(hum(50), RATE);
    d.push(hum(60), RATE);
    d.push(noise(-60), RATE);
    expect(d.push(hum(60), RATE)).toBeNull();
    expect(d.push(hum(60), RATE)).toBe(60);
  });
});
