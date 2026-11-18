import { describe, expect, it } from 'vitest';
import { degreeName, keyName, keySpelling, scalePitchClasses, transposeKey } from './keys';

describe('keySpelling', () => {
  it('uses flats in the flat keys', () => {
    expect(keySpelling({ tonic: 5, mode: 'major' })).toBe('flats'); // F
    expect(keySpelling({ tonic: 6, mode: 'major' })).toBe('flats'); // G♭
    expect(keySpelling({ tonic: 2, mode: 'minor' })).toBe('flats'); // Dm
    expect(keySpelling({ tonic: 3, mode: 'minor' })).toBe('flats'); // E♭m
  });

  it('uses sharps elsewhere and without a key', () => {
    expect(keySpelling({ tonic: 4, mode: 'major' })).toBe('sharps'); // E
    expect(keySpelling({ tonic: 9, mode: 'minor' })).toBe('sharps'); // Am
    expect(keySpelling({ tonic: 1, mode: 'minor' })).toBe('sharps'); // C♯m
    expect(keySpelling(null)).toBe('sharps');
  });
});

describe('keys', () => {
  it('names a key', () => {
    expect(keyName({ tonic: 9, mode: 'minor' }, 'sharps')).toBe('Am');
    expect(keyName({ tonic: 3, mode: 'major' }, 'flats')).toBe('E♭');
  });

  it('lists the scale from the tonic', () => {
    expect(scalePitchClasses({ tonic: 0, mode: 'major' })).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses({ tonic: 9, mode: 'minor' })).toEqual([9, 11, 0, 2, 4, 5, 7]);
  });

  it('names degrees from a root', () => {
    expect(degreeName(3, 0)).toBe('♭3');
    expect(degreeName(0, 0)).toBe('1');
    expect(degreeName(7, 0)).toBe('5');
    expect(degreeName(10, 0)).toBe('♭7');
    expect(degreeName(1, 2)).toBe('7');
  });

  it('transposes a key', () => {
    expect(transposeKey({ tonic: 9, mode: 'minor' }, 2)).toEqual({ tonic: 11, mode: 'minor' });
    expect(transposeKey({ tonic: 1, mode: 'major' }, -3)).toEqual({ tonic: 10, mode: 'major' });
  });
});
