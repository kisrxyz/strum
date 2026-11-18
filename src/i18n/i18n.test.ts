import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { L, getLanguage, setLanguage, withKey } from './index';
import { plural } from './plural';
import { ru } from './ru';

afterEach(() => setLanguage('en'));

describe('the current dictionary', () => {
  it('follows setLanguage', () => {
    setLanguage('en');
    expect(L().common.on).toBe('on');
    expect(getLanguage()).toBe('en');
    setLanguage('ru');
    expect(L().common.on).toBe('вкл');
    expect(getLanguage()).toBe('ru');
  });

  it('puts a key after its label', () => {
    expect(withKey('Loop', 'R')).toBe('Loop (R)');
  });

  it('formats units per language', () => {
    setLanguage('en');
    expect(L().common.units.pct(40)).toBe('40%');
    setLanguage('ru');
    expect(L().common.units.pct(40)).toBe('40 %');
  });
});

describe('plural', () => {
  const song = { one: 'песня', few: 'песни', many: 'песен', other: 'песни' };

  it('picks Russian forms by the number', () => {
    setLanguage('ru');
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, song))).toEqual([
      'песня',
      'песни',
      'песен',
      'песен',
      'песня',
      'песни',
      'песен',
    ]);
  });

  it('has one and other in English', () => {
    setLanguage('en');
    expect(plural(1, { one: 'song', other: 'songs' })).toBe('song');
    expect(plural(2, { one: 'song', other: 'songs' })).toBe('songs');
    expect(plural(0, { one: 'song', other: 'songs' })).toBe('songs');
  });
});

/** Every path of `en` with the `typeof` of its value. */
function shape(value: unknown, path = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  }
  return [`${path}:${Array.isArray(value) ? 'array' : typeof value}`];
}

describe('the Russian dictionary', () => {
  it('has every key of the English one, with the same kind of value', () => {
    expect(shape(ru).sort()).toEqual(shape(en).sort());
  });
});
