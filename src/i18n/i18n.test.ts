import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { de } from './de';
import { es } from './es';
import { fr } from './fr';
import { L, dictFor, getLanguage, setLanguage, withKey } from './index';
import { ja } from './ja';
import { decimal, detectLanguage, fileLang } from './lang';
import { pt } from './pt';
import { zh } from './zh';
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

describe('the other languages', () => {
  const partial = { es, pt, de, fr, ja, zh };

  it('show English where they have no word of their own', () => {
    for (const lang of ['es', 'pt', 'de', 'fr', 'ja', 'zh'] as const) {
      const dict = dictFor(lang);
      expect(shape(dict).sort()).toEqual(shape(en).sort());
      // A message none of them translates: it is the English one.
      expect(dict.service['audio.notFloat']).toBe(en.service['audio.notFloat']);
      // And a word each of them has.
      expect(dict.common.cancel).not.toBe(en.common.cancel);
    }
  });

  it('cover nearly all of the interface', () => {
    const total = shape(en).length;
    for (const [lang, dict] of Object.entries(partial)) {
      const own = shape(dict).length;
      expect(own / total, lang).toBeGreaterThan(0.85);
    }
  });

  it('name no key the English dictionary lacks', () => {
    const known = new Set(shape(en).map((line) => line.slice(0, line.lastIndexOf(':'))));
    for (const [lang, dict] of Object.entries(partial)) {
      const extra = shape(dict)
        .map((line) => line.slice(0, line.lastIndexOf(':')))
        .filter((path) => !known.has(path));
      expect(extra, lang).toEqual([]);
    }
  });
});

describe('the language of a first start', () => {
  it("is the system's first language that Strum speaks", () => {
    expect(detectLanguage(['pt-BR', 'en-US'])).toBe('pt');
    expect(detectLanguage(['kk-KZ', 'ru-RU', 'en'])).toBe('ru');
    expect(detectLanguage(['zh-Hans-CN'])).toBe('zh');
  });

  it('is English when the system names none', () => {
    expect(detectLanguage(['tr-TR', 'ko'])).toBe('en');
    expect(detectLanguage(undefined)).toBe('en');
    expect(detectLanguage([])).toBe('en');
  });
});

describe('figures', () => {
  it('have a decimal comma where the language writes one', () => {
    setLanguage('de');
    expect(decimal('2.7')).toBe('2,7');
    setLanguage('ja');
    expect(decimal('2.7')).toBe('2.7');
    setLanguage('en');
    expect(decimal('2.7')).toBe('2.7');
  });

  it('name downloaded files in English unless the language is Russian', () => {
    setLanguage('fr');
    expect(fileLang()).toBe('en');
    setLanguage('ru');
    expect(fileLang()).toBe('ru');
  });
});
