import { describe, expect, it } from 'vitest';
import { openStrings, shapeChord, shapeKey, shapePitchClass, shapeSpelling, soundingChord, type ViewOptions } from './display';

const view = (patch: Partial<ViewOptions> = {}): ViewOptions => ({ semitones: 0, capo: 0, tuning: 'standard', simple: false, ...patch });

describe('soundingChord', () => {
  it('moves the chord with the song and simplifies on request', () => {
    expect(soundingChord('A:min7', view({ semitones: 2, simple: true }))).toEqual({ root: 11, quality: 'min' });
    expect(soundingChord('A:min7', view({ semitones: -1 }))).toEqual({ root: 8, quality: 'min7' });
    expect(soundingChord('N', view())).toBeNull();
    expect(soundingChord('X', view())).toBeNull();
  });
});

describe('shapeChord', () => {
  it('names the E♭ tuning by the shapes you play', () => {
    expect(shapeChord('D#', view({ tuning: 'eb' }))).toEqual({ root: 4, quality: 'maj' });
  });

  it('counts from the capo', () => {
    expect(shapeChord('A', view({ capo: 2 }))).toEqual({ root: 7, quality: 'maj' });
    expect(shapeChord('A:min', view({ capo: 2, semitones: 1 }))).toEqual({ root: 8, quality: 'min' });
  });

  it('leaves drop D alone', () => {
    expect(shapeChord('D', view({ tuning: 'dropd' }))).toEqual({ root: 2, quality: 'maj' });
  });
});

describe('open strings and spelling', () => {
  it('raises the strings by the capo', () => {
    expect(openStrings(view({ capo: 2 }))).toEqual([42, 47, 52, 57, 61, 66]);
    expect(openStrings(view({ tuning: 'eb' }))).toEqual([39, 44, 49, 54, 58, 63]);
  });

  it('spells the shapes in the key the shapes are in', () => {
    // F major with a capo on 3 is played as D major: sharps
    expect(shapeSpelling({ tonic: 5, mode: 'major' }, view({ capo: 3 }))).toBe('sharps');
    expect(shapeSpelling({ tonic: 5, mode: 'major' }, view())).toBe('flats');
    // E♭ major in the E♭ tuning is played as E major
    expect(shapeSpelling({ tonic: 3, mode: 'major' }, view({ tuning: 'eb' }))).toBe('sharps');
    expect(shapeSpelling(null, view())).toBe('sharps');
    expect(shapeKey({ tonic: 9, mode: 'minor' }, view({ semitones: 2, capo: 2 }))).toEqual({ tonic: 9, mode: 'minor' });
    expect(shapeKey(null, view())).toBeNull();
  });

  it('turns a sounding note into the note of the shape', () => {
    expect(shapePitchClass(3, view({ tuning: 'eb' }))).toBe(4);
    expect(shapePitchClass(9, view({ capo: 2 }))).toBe(7);
    expect(shapePitchClass(9, view())).toBe(9);
  });
});
