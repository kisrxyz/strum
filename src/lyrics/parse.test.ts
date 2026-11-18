import { describe, expect, it } from 'vitest';
import { parseLyrics, transposeDoc, withCapo } from './parse';

const chordsOf = (line: { chords: { at: number; label: string }[] }) => line.chords.map((c) => `${c.label}@${c.at}`);

describe('parseLyrics: chords over lyrics', () => {
  it('puts the chords on the characters under them', () => {
    const doc = parseLyrics('Am        Dm\nНочь и тишина\n\nE7\n');
    expect(doc.format).toBe('chords-over');
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0].text).toBe('Ночь и тишина');
    expect(chordsOf(doc.lines[0])).toEqual(['A:min@0', 'D:min@10']);
    expect(doc.lines[1].text).toBe('');
    expect(chordsOf(doc.lines[1])).toEqual(['E:7@0']);
  });

  it('reads B as B♭ in a songbook that writes H (Russian amdm style)', () => {
    const doc = parseLyrics(['Dm      B      H7', 'Звезда по имени Солнце', 'B', 'Ещё строка'].join('\n'));
    expect(chordsOf(doc.lines[0])).toEqual(['D:min@0', 'A#@8', 'B:7@15']);
    expect(chordsOf(doc.lines[1])).toEqual(['A#@0']);
    // Without an H, B stays B.
    expect(chordsOf(parseLyrics(['Em  B', 'Line'].join('\n')).lines[0])).toEqual(['E:min@0', 'B@4']);
  });

  it('clamps chords past the end of a short line', () => {
    const doc = parseLyrics('Am            G\nКороткая');
    expect(chordsOf(doc.lines[0])).toEqual(['A:min@0', 'G@8']);
  });

  it('reads a browser paste the same', () => {
    const plain = parseLyrics('Am        Dm\nНочь и тишина\n\nE7\n');
    const pasted = parseLyrics('Am\t  Dm\r\nНочь и тишина\r\n\r\nE7\r\n'); // a tab stop is 8 columns
    expect(pasted.lines.map((l) => l.text)).toEqual(plain.lines.map((l) => l.text));
    expect(pasted.lines.map(chordsOf)).toEqual([['A:min@0', 'D:min@10'], ['E:7@0']]);
  });

  it('turns headings into sections and repeats a chorus written once', () => {
    const doc = parseLyrics(
      ['Куплет 1:', 'Am', 'первая строка', 'Припев:', 'F    G', 'припев строка', 'Куплет 2:', 'Dm', 'вторая строка', 'Припев.'].join('\n'),
    );
    expect(doc.lines.map((l) => [l.section, l.text])).toEqual([
      ['Куплет 1', 'первая строка'],
      ['Припев', 'припев строка'],
      ['Куплет 2', 'вторая строка'],
      ['Припев', 'припев строка'],
    ]);
  });

  it('reads an intro written next to its heading', () => {
    const doc = parseLyrics('Вступление: Am F C G\nAm\nслова');
    expect(doc.lines[0].section).toBe('Вступление');
    expect(doc.lines[0].text).toBe('');
    expect(doc.lines[0].chords.map((c) => c.label)).toEqual(['A:min', 'F', 'C', 'G']);
  });

  it('finds the capo and keeps it out of the lines', () => {
    for (const line of ['Каподастр на 3 ладу', 'капо 3', 'Capo: III', '(Capo 3)']) {
      const doc = parseLyrics(`${line}\nAm\nслова`);
      expect(doc.capo, line).toBe(3);
      expect(doc.lines).toHaveLength(1);
    }
  });

  it('reads H as B and slash chords by their main chord', () => {
    const doc = parseLyrics('Hm   Am/G\nслова и ещё слова');
    expect(doc.lines[0].chords.map((c) => [c.label, c.text])).toEqual([
      ['B:min', 'Hm'],
      ['A:min', 'Am/G'],
    ]);
  });

  it('keeps plain text plain', () => {
    const doc = parseLyrics('Раз два три\nчетыре пять');
    expect(doc.format).toBe('plain');
    expect(doc.lines.map((l) => l.text)).toEqual(['Раз два три', 'четыре пять']);
  });
});

describe('parseLyrics: ChordPro and LRC', () => {
  it('reads ChordPro', () => {
    const doc = parseLyrics('{title: Песня}\n{capo: 2}\n[Am]Ночь и [Dm]тишина\n{soc}\n[F]при[G]пев\n{eoc}');
    expect(doc.format).toBe('chordpro');
    expect(doc.capo).toBe(2);
    expect(doc.lines[0].text).toBe('Ночь и тишина');
    expect(chordsOf(doc.lines[0])).toEqual(['A:min@0', 'D:min@7']);
    // {soc} without a name: the chorus in the current language (the tests run in English).
    expect(doc.lines[1].section).toBe('Chorus');
    expect(doc.lines[1].text).toBe('припев');
    expect(chordsOf(doc.lines[1])).toEqual(['F@0', 'G@3']);
  });

  it('reads LRC with its times', () => {
    const doc = parseLyrics('[ar:Кто-то]\n[00:12.30]Первая строка\n[00:15.5]Вторая\n[01:02.123]Третья\n[01:10.00]');
    expect(doc.format).toBe('lrc');
    expect(doc.lines.map((l) => [l.time, l.text])).toEqual([
      [12.3, 'Первая строка'],
      [15.5, 'Вторая'],
      [62.123, 'Третья'],
    ]);
  });

  it('applies the LRC offset', () => {
    const doc = parseLyrics('[offset:+500]\n[00:10.00]a\n[00:11.00]b\n[00:12.00]c');
    expect(doc.lines[0].time).toBeCloseTo(9.5);
  });
});

describe('transposeDoc / withCapo', () => {
  it('moves the chords', () => {
    const doc = parseLyrics('Am   F\nслова');
    expect(transposeDoc(doc, 2).lines[0].chords.map((c) => c.label)).toEqual(['B:min', 'G']);
  });

  it('turns capo shapes into sounding chords', () => {
    const doc = withCapo(parseLyrics('Capo 2\nAm   F\nслова'));
    expect(doc.capo).toBe(0);
    expect(doc.lines[0].chords.map((c) => c.label)).toEqual(['B:min', 'G']);
  });
});
