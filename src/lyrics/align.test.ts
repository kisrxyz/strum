import { describe, expect, it } from 'vitest';
import type { ChordSegment } from '../song/types';
import { alignLyrics, chordsFromTrack, lineAt, matchWords, similarity, snapChords, type TimedLine, type TimedWord } from './align';
import { parseLyrics } from './parse';

const heard = (...items: [string, number][]): TimedWord[] => items.map(([word, start]) => ({ word, start, end: start + 0.4 }));
const starts = (lines: TimedLine[] | null) => lines!.map((l) => +l.start.toFixed(2));
const increasing = (lines: TimedLine[]) => lines.every((l, i) => i === 0 || l.start > lines[i - 1].start);

describe('similarity and matchWords', () => {
  it('scores near words high', () => {
    expect(similarity('тишина', 'тишина')).toBe(1);
    expect(similarity('тишина', 'тишину')).toBeGreaterThan(0.8);
    expect(similarity('ночь', 'дождь')).toBeLessThan(0.5);
  });

  it('skips a misheard word without shifting the rest', () => {
    const pairs = matchWords(['раз', 'два', 'три', 'четыре'], ['ой', 'раз', 'дво', 'три', 'четыре']);
    expect(pairs).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });
});

describe('alignLyrics', () => {
  it('takes the heard times when the words match', () => {
    const doc = parseLyrics('раз два три\nчетыре пять');
    const lines = alignLyrics(doc, heard(['раз', 1], ['два', 2], ['три', 3], ['четыре', 5], ['пять', 6]), [], 60);
    expect(starts(lines)).toEqual([1, 5]);
    expect(lines![0].words.map((w) => w.start)).toEqual([1, 2, 3]);
    expect(lines![0].end).toBe(5);
  });

  it('spreads lines when little is heard', () => {
    const doc = parseLyrics('первая строка тут\nвторая строка тут\nтретья строка тут\nчетвёртая строка тут');
    const lines = alignLyrics(doc, heard(['третья', 30]), [], 60)!;
    expect(increasing(lines)).toBe(true);
    expect(lines[2].start).toBeCloseTo(30);
    expect(lines[0].start).toBeLessThan(30);
    expect(lines[1].start).toBeLessThan(30);
    expect(lines[3].start).toBeGreaterThan(30);
    expect(lines[3].end).toBeLessThanOrEqual(60);
  });

  it('spreads lines over the singing when nothing matches', () => {
    const doc = parseLyrics('аа бб вв\nгг дд ее\nжж зз ии');
    const lines = alignLyrics(doc, heard(['хм', 10], ['ой', 20], ['ля', 40]), [], 60)!;
    expect(increasing(lines)).toBe(true);
    expect(lines[0].start).toBeCloseTo(10);
    expect(lines[2].start).toBeGreaterThan(20);
    expect(lines[2].start).toBeLessThan(40.5);
  });

  it('lets the user anchors win and drops ones that go back in time', () => {
    const doc = parseLyrics('раз два три\nчетыре пять\nшесть семь');
    const words = heard(['раз', 1], ['два', 2], ['три', 3], ['четыре', 25], ['пять', 26], ['шесть', 30], ['семь', 31]);
    expect(starts(alignLyrics(doc, words, [{ line: 1, time: 20 }], 60))).toEqual([1, 20, 30]);
    // an anchor for line 2 before the anchored line 1 cannot hold
    const both = alignLyrics(doc, words, [{ line: 1, time: 20 }, { line: 2, time: 10 }], 60)!;
    expect(both[1].start).toBe(20);
    expect(both[2].start).toBeGreaterThan(20);
  });

  it('uses .lrc times without heard words', () => {
    const doc = parseLyrics('[00:10.00]раз два\n[00:20.00]три четыре\n[00:30.00]пять шесть');
    expect(starts(alignLyrics(doc, [], [], 60))).toEqual([10, 20, 30]);
  });

  it('has nothing to go by without words, times or two anchors', () => {
    const doc = parseLyrics('раз два\nтри четыре');
    expect(alignLyrics(doc, [], [], 60)).toBeNull();
    expect(alignLyrics(doc, [], [{ line: 0, time: 3 }], 60)).toBeNull();
    expect(starts(alignLyrics(doc, [], [{ line: 0, time: 3 }, { line: 1, time: 9 }], 60))).toEqual([3, 9]);
  });

  it('puts an instrumental line in the gap between sung lines', () => {
    const doc = parseLyrics('Am\nраз два\nF   G\n\nC\nтри четыре');
    const lines = alignLyrics(doc, heard(['раз', 10], ['два', 11], ['три', 30], ['четыре', 31]), [], 60)!;
    expect(lines.map((l) => doc.lines[l.line].text)).toEqual(['раз два', '', 'три четыре']);
    expect(lines[1].start).toBeGreaterThan(11.3);
    expect(lines[1].start).toBeLessThan(30);
    expect(lines[1].chords.map((c) => c.label)).toEqual(['F', 'G']);
    expect(lines[1].chords[1].time).toBeGreaterThan(lines[1].chords[0].time);
  });

  it('gives a chord the time of the word under it', () => {
    const doc = parseLyrics('Am     Dm G\nраз два три');
    const lines = alignLyrics(doc, heard(['раз', 1], ['два', 2], ['три', 3]), [], 60)!;
    expect(lines[0].chords[0].time).toBeCloseTo(1);
    // «Dm» at column 7 stands over the space before «три»: it comes with that word
    expect(lines[0].chords[1].time).toBeCloseTo(3);
    // «G» at column 10 stands over the last letter of «три»
    expect(lines[0].chords[2].time).toBeGreaterThan(3.2);
    expect(lines[0].chords[2].time).toBeLessThan(3.4);
  });
});

describe('snapChords', () => {
  const track: ChordSegment[] = [
    { start: 0, end: 10, chord: 'G' },
    { start: 10, end: 20, chord: 'C' },
  ];
  const beats = Array.from({ length: 60 }, (_, i) => i * 0.5);
  const line = (label: string, time: number): TimedLine => ({ line: 0, start: 0, end: 30, words: [], chords: [{ at: 0, label, time }] });

  it('moves a chord to the change of the same root nearby', () => {
    expect(snapChords([line('C', 10.2)], track, beats)[0].chords[0].time).toBe(10);
  });

  it('else to the nearest beat within half a beat', () => {
    expect(snapChords([line('E:min', 12.1)], track, beats)[0].chords[0].time).toBe(12);
  });

  it('else leaves it', () => {
    expect(snapChords([line('E:min', 12.1)], [], [])[0].chords[0].time).toBe(12.1);
  });
});

describe('chordsFromTrack', () => {
  it('puts the chord track over lyrics that have no chords', () => {
    const doc = parseLyrics('[00:10.00]раз два три\n[00:20.00]четыре пять\n[00:40.00]шесть'); // .lrc needs 3 timed lines
    const lines = alignLyrics(doc, [], [], 60)!;
    const track: ChordSegment[] = [
      { start: 0, end: 9, chord: 'N' },
      { start: 9, end: 14, chord: 'A:min' },
      { start: 14, end: 30, chord: 'E:7' },
    ];
    const out = chordsFromTrack(doc, lines, track);
    // line 0 starts in Am (over its first letter), E7 comes during it; line 1 starts in E7
    expect(out.lines[0].chords.map((c) => [c.label, c.time])).toEqual([
      ['A:min', 10],
      ['E:7', 14],
    ]);
    expect(out.doc.lines[0].chords.map((c) => c.label)).toEqual(['A:min', 'E:7']);
    expect(out.lines[0].chords[1].at).toBeGreaterThan(0);
    expect(out.lines[1].chords.map((c) => c.label)).toEqual(['E:7']);
  });

  it('leaves lyrics with their own chords alone', () => {
    const doc = parseLyrics('[00:10.00]раз\n[00:20.00]два\n[00:30.00]три');
    const withChords = { ...doc, lines: doc.lines.map((l, i) => (i ? l : { ...l, chords: [{ at: 0, label: 'C', text: 'C' }] })) };
    const lines = alignLyrics(withChords, [], [], 60)!;
    expect(chordsFromTrack(withChords, lines, [{ start: 0, end: 60, chord: 'G' }]).doc).toBe(withChords);
  });
});

describe('lineAt', () => {
  it('finds the line being sung', () => {
    const lines = [0, 5, 9].map((start, i): TimedLine => ({ line: i, start, end: 0, words: [], chords: [] }));
    expect(lineAt(lines, -1)).toBe(-1);
    expect(lineAt(lines, 5)).toBe(1);
    expect(lineAt(lines, 100)).toBe(2);
  });
});
