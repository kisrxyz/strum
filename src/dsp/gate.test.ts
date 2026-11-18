import { describe, expect, it } from 'vitest';
import { GATE_AUTO, GATE_OFF_DB, GateCore } from './gate';
import { linToDb, measure } from './level';

const SR = 48000;

function noise(seconds: number, db: number, seedStart = 7): Float32Array {
  let seed = seedStart;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const amp = 10 ** (db / 20) * Math.sqrt(3); // uniform noise RMS = amp / sqrt(3)
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => amp * rand());
}

function sine(seconds: number, db: number, freq: number): Float32Array {
  const amp = 10 ** (db / 20) * Math.SQRT2; // sine RMS = amp / sqrt(2)
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR));
}

function run(gate: GateCore, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128) {
    gate.process(input.subarray(i, i + 128), out.subarray(i, i + 128));
  }
  return out;
}

describe('GateCore', () => {
  it('passes a played note almost untouched', () => {
    const gate = new GateCore(SR, { thresholdDb: -50 });
    const burst = sine(0.2, -20, 200);
    const out = run(gate, burst);
    expect(measure(out).rms / measure(burst).rms).toBeGreaterThan(0.95);
  });

  it('silences hiss after the note ends', () => {
    const gate = new GateCore(SR, { thresholdDb: -50 });
    const burst = sine(0.2, -20, 200);
    const hiss = noise(1, -70);
    const input = new Float32Array(burst.length + hiss.length);
    input.set(burst);
    input.set(hiss, burst.length);
    const out = run(gate, input);
    const tailStart = burst.length + Math.round(0.5 * SR);
    const tail = out.subarray(tailStart, tailStart + Math.round(0.2 * SR));
    expect(linToDb(measure(tail).rms)).toBeLessThan(-90);
  });

  it('never opens on hiss alone', () => {
    const gate = new GateCore(SR, { thresholdDb: -50 });
    run(gate, noise(0.5, -70, 3));
    expect(gate.isOpen).toBe(false);
  });

  it('follows a new threshold', () => {
    const gate = new GateCore(SR, { thresholdDb: -50 });
    gate.setThreshold(-80);
    run(gate, noise(0.2, -70, 5));
    expect(gate.isOpen).toBe(true);
  });
});

/** `parts` one after another. */
function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `a` with `b` added from `at` seconds on. */
function mixAt(a: Float32Array, b: Float32Array, at: number): Float32Array {
  const out = Float32Array.from(a);
  const start = Math.round(at * SR);
  for (let i = 0; i < b.length && start + i < out.length; i++) out[start + i] += b[i];
  return out;
}

/** A plucked note: a sine with a sharp attack and a ringing tail, `db` at its peak. */
function pluck(seconds: number, db: number, freq = 196): Float32Array {
  const amp = 10 ** (db / 20);
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => {
    const t = i / SR;
    return amp * Math.sin(2 * Math.PI * freq * t) * (0.7 * Math.exp(-25 * t) + 0.3 * Math.exp(-3 * t));
  });
}

/** The gate run block by block; the share of blocks it was open in, from `from` seconds on. */
function openShare(gate: GateCore, input: Float32Array, from = 0): number {
  const out = new Float32Array(128);
  let open = 0;
  let blocks = 0;
  for (let i = 0; i + 128 <= input.length; i += 128) {
    gate.process(input.subarray(i, i + 128), out);
    if (i >= from * SR) {
      blocks++;
      if (gate.isOpen) open++;
    }
  }
  return open / blocks;
}

describe('GateCore, «Шумодав сам»', () => {
  // The author's input at rest holds the envelope near −60 dBFS (hiss of −66 dB RMS): over the
  // clean preset's −70 and the crunch's −64.
  const REST_DB = -66;

  it('alone, a threshold under the noise never closes: the reason for all this', () => {
    const gate = new GateCore(SR, { thresholdDb: -64 });
    expect(openShare(gate, mixAt(noise(8, REST_DB), pluck(1, -9), 1), 4)).toBe(1);
  });

  it('is shut on the noise from the first moment, and shuts again after a note', () => {
    const gate = new GateCore(SR, { thresholdDb: -64, auto: true });
    const input = mixAt(noise(14, REST_DB), pluck(1, -9), 8);
    expect(openShare(gate, input.subarray(0, 8 * SR))).toBe(0);
    // The note opens it (its first half second is all there)…
    const note = new Float32Array(SR / 2);
    gate.process(input.subarray(8 * SR, 8.5 * SR), note);
    expect(measure(note).rms / measure(input.subarray(8 * SR, 8.5 * SR)).rms).toBeGreaterThan(0.98);
    // …and once it has faded into the noise the gate is shut for good.
    expect(openShare(gate, input.subarray(8.5 * SR), 2)).toBe(0);
  });

  it('finds the floor and opens a fixed margin over it', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    run(gate, noise(8, REST_DB));
    expect(gate.floorDb).toBeGreaterThan(REST_DB + 3);
    expect(gate.floorDb).toBeLessThan(REST_DB + 9);
    expect(gate.openDb).toBeCloseTo(gate.floorDb + GATE_AUTO.marginDb, 6);
  });

  it('never opens lower than the preset asks', () => {
    const gate = new GateCore(SR, { thresholdDb: -40, auto: true });
    run(gate, noise(8, REST_DB));
    expect(gate.openDb).toBeCloseTo(-40, 6);
  });

  it('follows a noise that got louder within seconds (the guitar was plugged in)', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    const input = join(noise(4, -92), noise(14, REST_DB, 11));
    const open = openShare(gate, input, 4 + 7);
    expect(open).toBe(0);
    expect(gate.openDb).toBeGreaterThan(-56);
  });

  it('follows a noise that got quieter at once', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    run(gate, noise(8, REST_DB));
    const before = gate.floorDb;
    run(gate, noise(1.5, REST_DB - 12, 5));
    expect(gate.floorDb).toBeCloseTo(before - 12, 0);
  });

  it('does not take a ringing note for noise', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    run(gate, noise(8, REST_DB));
    const floor = gate.floorDb;
    // A chord left to ring for 12 s, fading 3 dB a second, over the same noise.
    const ring = Float32Array.from({ length: 12 * SR }, (_, i) => {
      const t = i / SR;
      return 10 ** ((-12 - 3 * t) / 20) * Math.sin(2 * Math.PI * 147 * t);
    });
    const input = mixAt(noise(12, REST_DB, 21), ring, 0);
    // Open while the note is over the noise (the first 10 s: −12 … −42 dBFS).
    expect(openShare(gate, input.subarray(0, 10 * SR))).toBe(1);
    expect(Math.abs(gate.floorDb - floor)).toBeLessThan(1);
  });

  it('does not take steady soft playing for noise', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    run(gate, noise(8, REST_DB));
    const { floorDb, openDb } = gate;
    // Notes four times a second for 30 s, their peaks 10 dB over the level that opens the gate.
    let input = noise(30, REST_DB, 31);
    for (let n = 0; n < 120; n++) input = mixAt(input, pluck(0.25, openDb + 10), n / 4);
    const plain = new GateCore(SR, { thresholdDb: openDb });
    const kept = measure(run(gate, input)).rms;
    expect(kept / measure(run(plain, input)).rms).toBeGreaterThan(0.999);
    expect(Math.abs(gate.floorDb - floorDb)).toBeLessThan(0.5);
  });

  it('never sets a threshold over its cap, and comes back after a drone', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    run(gate, noise(8, REST_DB));
    const open = gate.openDb;
    run(gate, mixAt(noise(10, REST_DB, 41), sine(10, -30, 220), 0)); // feedback, an e-bow: flat and steady
    expect(gate.isOpen).toBe(true);
    expect(gate.openDb).toBeCloseTo(GATE_AUTO.capDb, 6);
    run(gate, noise(2, REST_DB, 43));
    expect(gate.isOpen).toBe(false);
    expect(gate.openDb).toBeCloseTo(open, 0);
  });

  it('moves its floor with the input when the channel pick changes', () => {
    // «Both»: half of the guitar's side. The first note makes the app pick that side: everything
    // doubles, the noise too. Told so, the gate shuts after that note at once, not five seconds later.
    const half = (x: Float32Array) => x.map((v) => v / 2);
    const told = new GateCore(SR, { thresholdDb: -70, auto: true });
    const untold = new GateCore(SR, { thresholdDb: -70, auto: true });
    for (const gate of [told, untold]) run(gate, half(noise(8, REST_DB)));
    const before = told.floorDb;
    told.scaleFloor(2);
    expect(told.floorDb).toBeCloseTo(before + 20 * Math.log10(2), 6);
    const after = mixAt(noise(4, REST_DB, 61), pluck(1, -9), 0);
    expect(openShare(told, after, 2)).toBe(0);
    expect(openShare(untold, after, 2)).toBe(1);
    // Nonsense is ignored.
    told.scaleFloor(0);
    told.scaleFloor(Number.NaN);
    expect(told.isOpen).toBe(false);
  });

  it('is off when the slider says «выкл»', () => {
    const gate = new GateCore(SR, { thresholdDb: GATE_OFF_DB, auto: true });
    expect(openShare(gate, noise(8, REST_DB), 1)).toBe(1);
  });

  it('switches by hand: off gives the preset threshold back, on applies what was learned', () => {
    const gate = new GateCore(SR, { thresholdDb: -70, auto: true });
    run(gate, noise(8, REST_DB));
    const learned = gate.openDb;
    gate.setAuto(false);
    expect(gate.openDb).toBeCloseTo(-70, 6);
    run(gate, noise(1, REST_DB, 51));
    expect(gate.isOpen).toBe(true);
    gate.setAuto(true);
    expect(gate.openDb).toBeCloseTo(learned, 1);
  });
});
