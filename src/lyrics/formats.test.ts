import { describe, expect, it } from 'vitest';
import type { ChordSegment } from '../song/types';
import { alignLyrics } from './align';
import { toChordPro, toLrc } from './formats';
import { textShift } from './keyShift';
import { pickLrclib, lrclibSearchUrl, type LrclibHit } from './lrclib';
import { parseLyrics, withCapo } from './parse';

const track = (...labels: string[]): ChordSegment[] =>
  Array.from({ length: 4 }, (_, round) => labels.map((chord, i) => ({ start: (round * labels.length + i) * 2, end: (round * labels.length + i + 1) * 2, chord }))).flat();

describe('textShift', () => {
  const text = (chords: string) => parseLyrics(Array.from({ length: 4 }, () => `${chords}\nслова`).join('\n'));

  it('finds the shift between the text and the recording', () => {
    expect(textShift(text('Am  F  C  G'), track('B:min', 'G', 'D', 'A'))).toBe(2);
    expect(textShift(text('Am  F  C  G'), track('G:min', 'D#', 'A#', 'F'))).toBe(-2);
  });

  it('keeps the same key', () => {
    expect(textShift(text('Am  F  C  G'), track('A:min', 'F', 'C', 'G'))).toBe(0);
  });

  it('applies the capo first', () => {
    const doc = withCapo(parseLyrics(`Capo 2\n${Array.from({ length: 4 }, () => 'Am  F  C  G\nслова').join('\n')}`));
    expect(textShift(doc, track('B:min', 'G', 'D', 'A'))).toBe(0);
  });

  it('gives 0 without chords', () => {
    expect(textShift(parseLyrics('слова\nещё'), track('A:min'))).toBe(0);
    expect(textShift(text('Am'), [])).toBe(0);
  });
});

describe('toLrc / toChordPro', () => {
  it('round-trips .lrc times', () => {
    const doc = parseLyrics('раз два\nтри четыре\nпять шесть');
    const lines = alignLyrics(doc, [], [{ line: 0, time: 1.234 }, { line: 1, time: 62.5 }, { line: 2, time: 70 }], 180)!;
    const back = parseLyrics(toLrc(doc, lines, 'Песня', 'Кто'));
    expect(back.format).toBe('lrc');
    expect(back.lines.map((l) => [l.time, l.text])).toEqual([
      [1.23, 'раз два'],
      [62.5, 'три четыре'],
      [70, 'пять шесть'],
    ]);
  });

  it('round-trips ChordPro chords and sections', () => {
    const doc = parseLyrics('Капо 2\nПрипев:\nAm     Dm\nНочь и тишина\nE7');
    const back = parseLyrics(toChordPro(doc, 'Песня', 'Кто'));
    expect(back.capo).toBe(2);
    expect(back.lines.map((l) => [l.section, l.text, l.chords.map((c) => `${c.text}@${c.at}`)])).toEqual([
      ['Припев', 'Ночь и тишина', ['Am@0', 'Dm@7']],
      ['Припев', '', ['E7@0']],
    ]);
  });
});

describe('LRCLIB', () => {
  const hit = (id: number, duration: number, synced: boolean): LrclibHit => ({
    id,
    trackName: 'Кайен',
    artistName: 'Валентин Стрыкало',
    duration,
    plainLyrics: 'слова',
    syncedLyrics: synced ? '[00:01.00]слова' : null,
  });

  it('asks by artist and title only', () => {
    expect(lrclibSearchUrl(' Валентин Стрыкало ', 'Кайен')).toBe(
      'https://lrclib.net/api/search?track_name=%D0%9A%D0%B0%D0%B9%D0%B5%D0%BD&artist_name=%D0%92%D0%B0%D0%BB%D0%B5%D0%BD%D1%82%D0%B8%D0%BD+%D0%A1%D1%82%D1%80%D1%8B%D0%BA%D0%B0%D0%BB%D0%BE',
    );
  });

  it('prefers timed lyrics of the same length', () => {
    expect(pickLrclib([hit(1, 182, false), hit(2, 185, true)], 182)?.id).toBe(2);
    expect(pickLrclib([hit(1, 182, true), hit(2, 181, true)], 181.5)?.id).toBe(1);
    expect(pickLrclib([hit(1, 120, true), hit(2, 300, true)], 182)).toBeNull();
  });
});
