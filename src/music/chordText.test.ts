import { describe, expect, it } from 'vitest';
import { chordColumns, isChordLine, parseChordText, usesGermanB } from './chordText';

describe('parseChordText', () => {
  it('reads songbook spellings, H as B', () => {
    expect(parseChordText('Hm')).toEqual({ chord: { root: 11, quality: 'min' }, bass: null });
    expect(parseChordText('H7')?.chord).toEqual({ root: 11, quality: '7' });
    expect(parseChordText('Am/G')).toEqual({ chord: { root: 9, quality: 'min' }, bass: 7 });
    expect(parseChordText('A#m7')?.chord).toEqual({ root: 10, quality: 'min7' });
    expect(parseChordText('Bb')?.chord).toEqual({ root: 10, quality: 'maj' });
    expect(parseChordText('C(add9)')?.chord).toEqual({ root: 0, quality: 'maj' });
    expect(parseChordText('E5')?.chord).toEqual({ root: 4, quality: 'maj' });
    expect(parseChordText('Fmaj7')?.chord).toEqual({ root: 5, quality: 'maj7' });
    expect(parseChordText('FM7')?.chord).toEqual({ root: 5, quality: 'maj7' });
    expect(parseChordText('Dsus')?.chord).toEqual({ root: 2, quality: 'sus4' });
    expect(parseChordText('Bm7b5')?.chord).toEqual({ root: 11, quality: 'hdim7' });
    expect(parseChordText('Cm(maj7)')?.chord).toEqual({ root: 0, quality: 'minmaj7' });
    expect(parseChordText('(Em)')?.chord).toEqual({ root: 4, quality: 'min' });
    expect(parseChordText('G6')?.chord).toEqual({ root: 7, quality: 'maj6' });
  });

  it('refuses words and marks', () => {
    for (const token of ['Привет', 'x2', 'А', 'Am7xyz', 'Be', 'am', '', 'Go', 'Ah']) {
      expect(parseChordText(token), token).toBeNull();
    }
  });
});

describe('isChordLine', () => {
  it('knows a chord line', () => {
    expect(isChordLine('Am   F  C   G')).toBe(true);
    expect(isChordLine('Am | F | x2')).toBe(true);
    expect(isChordLine('  H7  (2 раза)')).toBe(true);
  });

  it('knows a lyrics line', () => {
    expect(isChordLine('А мы не ангелы')).toBe(false); // Cyrillic «А»
    expect(isChordLine('A man is here')).toBe(false);
    expect(isChordLine('')).toBe(false);
    expect(isChordLine('| x2 |')).toBe(false);
  });
});

describe('chordColumns', () => {
  it('keeps where each chord starts', () => {
    expect(chordColumns('Am        Dm').map((c) => [c.at, c.text])).toEqual([
      [0, 'Am'],
      [10, 'Dm'],
    ]);
  });
});

describe('songbooks that write H for B', () => {
  it('read B as B♭ there, and as B anywhere else', () => {
    expect(parseChordText('B', true)?.chord).toEqual({ root: 10, quality: 'maj' });
    expect(parseChordText('Bm', true)?.chord).toEqual({ root: 10, quality: 'min' });
    expect(parseChordText('Hm', true)?.chord).toEqual({ root: 11, quality: 'min' });
    expect(parseChordText('Am/B', true)?.bass).toBe(10);
    expect(parseChordText('B')?.chord).toEqual({ root: 11, quality: 'maj' });
    expect(chordColumns('Dm  B  C', true).map((c) => c.chord.root)).toEqual([2, 10, 0]);
    // Some such books still write the flat: Bb is B♭ there too, not A.
    expect(parseChordText('Bb', true)?.chord).toEqual({ root: 10, quality: 'maj' });
    expect(parseChordText('B♭m', true)?.chord).toEqual({ root: 10, quality: 'min' });
  });

  it('are known by an H chord in a chord line', () => {
    expect(usesGermanB(['Am H7 E', 'Слова строки'])).toBe(true);
    expect(usesGermanB(['Dm B C', 'Hello there'])).toBe(false);
    // A word that starts with H in a lyric line is not a chord.
    expect(usesGermanB(['Am C', 'Hold me now'])).toBe(false);
    // A hummed «Hm» alone on a line is weak evidence: one H in a line of chords, or H in two lines.
    expect(usesGermanB(['Em  B', 'Hm', 'Em  B'])).toBe(false);
    expect(usesGermanB(['H7', 'Слова', 'H7'])).toBe(true);
  });
});
