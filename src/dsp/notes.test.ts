import { describe, expect, it } from 'vitest';
import { describePitch, freqToMidi, midiToFreq, nearestString, tuneState } from './notes';

describe('notes', () => {
  it('maps A4 = 440 Hz to MIDI 69 and back', () => {
    expect(freqToMidi(440)).toBe(69);
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });

  it('names the low E string', () => {
    const note = describePitch(82.41);
    expect(note.name).toBe('E');
    expect(note.solfege).toBe('ми');
    expect(note.octave).toBe(2);
    expect(Math.abs(note.cents)).toBeLessThan(1);
  });

  it('reports cents sharp of the nearest note', () => {
    expect(describePitch(445).name).toBe('A');
    expect(describePitch(445).cents).toBeCloseTo(19.56, 1);
  });

  it('respects a custom A4 calibration', () => {
    // 440 Hz against A4 = 432 Hz is about 31.8 cents sharp.
    expect(describePitch(440, 432).cents).toBeCloseTo(31.77, 1);
  });

  it('uses sharps for black keys', () => {
    expect(describePitch(466.16).name).toBe('A♯');
    expect(describePitch(466.16).solfege).toBe('ля♯');
  });

  it('finds the nearest open string in standard tuning', () => {
    expect(nearestString(45.1)).toEqual({ stringNumber: 5, cents: expect.closeTo(10, 5) });
    expect(nearestString(40)).toEqual({ stringNumber: 6, cents: 0 });
    expect(nearestString(64.2)?.stringNumber).toBe(1);
  });

  it('gives no string hint far from every open string', () => {
    expect(nearestString(70)).toBeNull();
  });

  it('finds the strings of another tuning', () => {
    const dropD = [38, 45, 50, 55, 59, 64];
    expect(nearestString(50, dropD)).toEqual({ stringNumber: 4, cents: 0 });
    expect(nearestString(38, dropD)).toEqual({ stringNumber: 6, cents: 0 });
    expect(nearestString(39.5, dropD)).toEqual({ stringNumber: 6, cents: expect.closeTo(150, 5) });
    // D4 is an octave above the 4th string, far from every open string
    expect(nearestString(62, dropD)).toBeNull();
    const eFlat = [39, 44, 49, 54, 58, 63];
    expect(nearestString(39, eFlat)).toEqual({ stringNumber: 6, cents: 0 });
    expect(nearestString(63.1, eFlat)?.stringNumber).toBe(1);
  });

  it('classifies tuning accuracy', () => {
    expect(tuneState(2)).toBe('in');
    expect(tuneState(-3)).toBe('in');
    expect(tuneState(10)).toBe('close');
    expect(tuneState(-30)).toBe('off');
  });
});
