import { describe, expect, it } from 'vitest';
import { loopActive, markA, markB, motionAt, nextBookmark, positionAt, seekBy, stepPitch, stepSpeed, wrapTimes, wrapsUntil } from './schedule';

const noLoop = { start: 0, end: 0, on: false };
const loop48 = { start: 4, end: 8, on: true };

describe('motionAt', () => {
  const playing = { at: 10, pos: 5, rate: 0.8, playing: true };

  it('runs to the end of the song at the playback rate', () => {
    const m = motionAt(playing, noLoop, 12, 180);
    expect(m.pos).toBeCloseTo(6.6, 9);
    expect(m.rate).toBe(0.8);
    expect(m.until).toBe(180);
  });

  it('runs to the end of an active loop', () => {
    expect(motionAt(playing, { start: 4, end: 8, on: true }, 12, 180).until).toBe(8);
  });

  it('stands while paused, during a count-in and at the end', () => {
    expect(motionAt({ ...playing, playing: false }, noLoop, 12, 180)).toEqual({ pos: 5, rate: 0, until: 5 });
    expect(motionAt(playing, noLoop, 9, 180)).toEqual({ pos: 5, rate: 0, until: 5 });
    expect(motionAt(playing, noLoop, 400, 180)).toEqual({ pos: 180, rate: 0, until: 180 });
  });
});

describe('positionAt', () => {
  it('moves at the playback rate', () => {
    expect(positionAt({ at: 10, pos: 5, rate: 0.8, playing: true }, noLoop, 12)).toBeCloseTo(6.6, 9);
  });

  it('stands still on pause and before the change takes effect', () => {
    expect(positionAt({ at: 10, pos: 5, rate: 0.8, playing: false }, noLoop, 20)).toBe(5);
    expect(positionAt({ at: 10, pos: 5, rate: 1, playing: true }, noLoop, 9)).toBe(5);
  });

  it('wraps inside an active loop like the worklet does', () => {
    expect(positionAt({ at: 0, pos: 5, rate: 1, playing: true }, loop48, 4)).toBeCloseTo(5, 9);
    expect(positionAt({ at: 0, pos: 5, rate: 1, playing: true }, loop48, 12)).toBeCloseTo(5, 9);
    // before the loop it plays on until the loop end, then wraps
    expect(positionAt({ at: 0, pos: 1, rate: 1, playing: true }, loop48, 2)).toBeCloseTo(3, 9);
    expect(positionAt({ at: 0, pos: 1, rate: 1, playing: true }, loop48, 8)).toBeCloseTo(5, 9);
  });

  it('ignores a loop that is off or too short', () => {
    expect(positionAt({ at: 0, pos: 5, rate: 1, playing: true }, { ...loop48, on: false }, 4)).toBeCloseTo(9, 9);
    expect(positionAt({ at: 0, pos: 5, rate: 1, playing: true }, { start: 5, end: 5.3, on: true }, 1)).toBeCloseTo(6, 9);
  });
});

describe('seekBy', () => {
  it('goes round inside an active loop', () => {
    expect(seekBy(7, 5, loop48, 180)).toBeCloseTo(4, 9);
    expect(seekBy(5, -5, loop48, 180)).toBeCloseTo(4, 9);
    expect(seekBy(6, -1, loop48, 180)).toBeCloseTo(5, 9);
  });

  it('stops at the song edges otherwise', () => {
    expect(seekBy(178, 5, noLoop, 180)).toBe(180);
    expect(seekBy(2, -5, noLoop, 180)).toBe(0);
    expect(seekBy(20, 5, loop48, 180)).toBe(25); // outside the loop: plain seek
  });
});

describe('markA / markB', () => {
  it('needs A before B', () => {
    expect(markB(noLoop, 10)).toBeNull();
  });

  it('A then B makes a loop and turns it on', () => {
    const a = markA(noLoop, 5, 180);
    expect(a).toEqual({ start: 5, end: 0, on: false });
    expect(markB(a, 12)).toEqual({ start: 5, end: 12, on: true });
  });

  it('A at the very start of the song still counts', () => {
    expect(markB(markA(noLoop, 0, 180), 10)).toMatchObject({ end: 10, on: true });
  });

  it('B too close to A does nothing', () => {
    expect(markB(markA(noLoop, 5, 180), 5.2)).toBeNull();
  });

  it('A moves the start of an existing loop and keeps it running', () => {
    expect(markA(loop48, 5, 180)).toEqual({ start: 5, end: 8, on: true });
    expect(markA(loop48, 7.8, 180)).toEqual({ start: 7.8, end: 0, on: false });
  });

  it('a loop shorter than half a second is not active', () => {
    expect(loopActive({ start: 5, end: 5.3, on: true })).toBe(false);
    expect(loopActive(loop48)).toBe(true);
  });
});

describe('stepSpeed / stepPitch', () => {
  it('steps the speed by 5 % between 50 and 100 %', () => {
    expect(stepSpeed(0.8, 1)).toBe(0.85);
    expect(stepSpeed(1, 1)).toBe(1);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    let speed = 0.5;
    for (let i = 0; i < 10; i++) speed = stepSpeed(speed, 1);
    expect(speed).toBe(1);
  });

  it('steps semitones within ±2 and cents by 5 within ±50', () => {
    expect(stepPitch({ semitones: 2, cents: 0 }, 1, false)).toEqual({ semitones: 2, cents: 0 });
    expect(stepPitch({ semitones: 0, cents: 0 }, -1, false)).toEqual({ semitones: -1, cents: 0 });
    expect(stepPitch({ semitones: 1, cents: 45 }, 1, true)).toEqual({ semitones: 1, cents: 50 });
    expect(stepPitch({ semitones: 1, cents: 50 }, 1, true)).toEqual({ semitones: 1, cents: 50 });
    expect(stepPitch({ semitones: 0, cents: -50 }, -1, true)).toEqual({ semitones: 0, cents: -50 });
  });
});

describe('nextBookmark', () => {
  const marks = [
    { name: '1', start: 10, end: 20 },
    { name: '2', start: 30, end: 40 },
    { name: '3', start: 50, end: 60 },
  ];

  it('goes to the bookmark after the current loop and round', () => {
    expect(nextBookmark(marks, { start: 30, end: 40, on: true })).toBe(2);
    expect(nextBookmark(marks, { start: 50, end: 60, on: true })).toBe(0);
  });

  it('starts from the first one when the loop is not a bookmark', () => {
    expect(nextBookmark(marks, noLoop)).toBe(0);
    expect(nextBookmark([], noLoop)).toBe(-1);
  });
});

describe('wrapTimes / wrapsUntil', () => {
  const loop = { start: 10, end: 14, on: true };
  const t = { at: 100, pos: 12, rate: 1, playing: true };

  it('lists when the loop comes round', () => {
    expect(wrapTimes(t, loop, 100, 3)).toEqual([102, 106, 110]);
    expect(wrapTimes(t, loop, 102, 2)).toEqual([106, 110]); // a wrap exactly at `from` is past
    expect(wrapTimes(t, loop, 107.5, 1)).toEqual([110]);
    expect(wrapTimes({ ...t, rate: 0.5 }, loop, 100, 2)).toEqual([104, 112]);
  });

  it('agrees with positionAt', () => {
    for (const w of wrapTimes({ ...t, rate: 0.8 }, loop, 100, 4)) {
      expect(positionAt({ ...t, rate: 0.8 }, loop, w - 0.001)).toBeGreaterThan(13.99);
      expect(positionAt({ ...t, rate: 0.8 }, loop, w + 0.001)).toBeLessThan(10.01);
    }
  });

  it('counts the passes', () => {
    expect(wrapsUntil(t, loop, 101)).toBe(0);
    expect(wrapsUntil(t, loop, 102)).toBe(1);
    expect(wrapsUntil(t, loop, 109)).toBe(2);
    expect(wrapsUntil(t, loop, 99)).toBe(0);
  });

  it('starts before the loop and past its end', () => {
    expect(wrapTimes({ ...t, pos: 5 }, loop, 100, 2)).toEqual([109, 113]);
    expect(wrapTimes({ ...t, pos: 15 }, loop, 100, 1)).toEqual([103]); // wrapped to 11 at once
  });

  it('never comes round when paused or without a loop', () => {
    expect(wrapTimes({ ...t, playing: false }, loop, 100, 3)).toEqual([]);
    expect(wrapTimes(t, { ...loop, on: false }, 100, 3)).toEqual([]);
    expect(wrapsUntil({ ...t, playing: false }, loop, 200)).toBe(0);
  });
});
