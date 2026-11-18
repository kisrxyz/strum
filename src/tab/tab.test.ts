import * as alphaTab from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { buildBars, type Bar } from '../music/bars';
import type { ChordSegment } from '../song/types';
import { tabBars, type MasterBarTicks } from './score';
import { autoSync, nudgeSync, syncTimes, tempoRatio, type TabBar } from './sync';
import { isTextTab, textTabToAlphaTex } from './textTab';
import { shiftFret } from './transpose';

/** Recording bars of `seconds` each from `start`, 4 beats per bar. */
function recordingBars(count: number, seconds: number, start = 0): Bar[] {
  const beats = Array.from({ length: count * 4 }, (_, i) => start + (i * seconds) / 4);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return buildBars(beats, downbeats, 0, start + count * seconds);
}

/** Tab bars of 2 s with one root each. */
const tab = (roots: number[]): TabBar[] => roots.map((root, i) => ({ index: i, occurrence: 0, start: i * 2, seconds: 2, roots: [root, root] }));

/** A chord track: `labels[i]` on recording bar `from + i`. */
function track(bars: Bar[], from: number, labels: string[]): ChordSegment[] {
  const out: ChordSegment[] = [{ start: 0, end: bars[from].start, chord: 'N' }];
  labels.forEach((chord, i) => {
    const bar = bars[from + i];
    if (bar) out.push({ start: bar.start, end: bar.end, chord });
  });
  return out;
}

describe('tempoRatio', () => {
  it('sees a doubled or halved tempo', () => {
    expect(tempoRatio(120, 120)).toBe(1);
    expect(tempoRatio(120, 240)).toBe(2);
    expect(tempoRatio(120, 61)).toBe(0.5);
    expect(tempoRatio(120, 168)).toBe(1); // 1.4: none fits
    expect(tempoRatio(0, 120)).toBe(1);
  });
});

describe('autoSync', () => {
  const roots = [9, 2, 4, 9, 9, 2, 4, 9, 9, 2, 4, 9, 9, 2, 4, 9]; // A D E A …
  const labels = ['A:min', 'D:min', 'E', 'A:min', 'A:min', 'D:min', 'E', 'A:min', 'A:min', 'D:min', 'E', 'A:min', 'A:min', 'D:min', 'E', 'A:min'];

  it('finds where the tab starts by its chords', () => {
    const bars = recordingBars(24, 2);
    expect(autoSync(tab(roots), bars, track(bars, 3, labels), 120, 120)).toEqual({ offset: 3, ratio: 1 });
  });

  it('counts a doubled tempo two recording bars per tab bar', () => {
    const bars = recordingBars(48, 1);
    const doubled: string[] = labels.flatMap((l) => [l, l]);
    expect(autoSync(tab(roots), bars, track(bars, 6, doubled), 120, 240)).toEqual({ offset: 6, ratio: 2 });
  });

  it('starts at the first chord when nothing matches', () => {
    const bars = recordingBars(10, 2);
    const silent = tab([]).concat({ index: 0, occurrence: 0, start: 0, seconds: 2, roots: [] });
    expect(autoSync(silent, bars, track(bars, 2, ['C', 'G']), 120, 120)).toEqual({ offset: 2, ratio: 1 });
  });
});

describe('syncTimes', () => {
  it('puts repeats on consecutive recording bars', () => {
    const bars = recordingBars(10, 2);
    const order: TabBar[] = [0, 1, 2, 1, 2, 3].map((index, i) => ({ index, occurrence: i === 3 || i === 4 ? 1 : 0, start: i * 2, seconds: 2, roots: [] }));
    const times = syncTimes(order, bars, { offset: 1, ratio: 1 });
    expect(times.map((t) => t.time)).toEqual([2, 4, 6, 8, 10, 12]);
    expect(times.map((t) => [t.index, t.occurrence])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
      [3, 0],
    ]);
  });

  it('runs on past the end of the recording', () => {
    const times = syncTimes(tab(new Array(10).fill(0)), recordingBars(6, 2), { offset: 0, ratio: 1 });
    expect(times.map((t) => +t.time.toFixed(3))).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('keeps bars before the recording increasing', () => {
    const times = syncTimes(tab([0, 0, 0, 0]), recordingBars(6, 2, 1), { offset: -2, ratio: 1 });
    expect(times[0].time).toBe(0);
    expect(times.every((t, i) => i === 0 || t.time > times[i - 1].time)).toBe(true);
    expect(times[2].time).toBe(1);
  });

  it('halves: two tab bars per recording bar', () => {
    const times = syncTimes(tab([0, 0, 0, 0]), recordingBars(6, 2), { offset: 0, ratio: 0.5 });
    expect(times.map((t) => t.time)).toEqual([0, 1, 2, 3]);
  });
});

describe('nudgeSync', () => {
  it('moves by one tab bar', () => {
    expect(nudgeSync({ offset: 3, ratio: 1 }, 1)).toEqual({ offset: 4, ratio: 1 });
    expect(nudgeSync({ offset: 3, ratio: 2 }, -1)).toEqual({ offset: 1, ratio: 2 });
  });
});

describe('shiftFret', () => {
  it('follows the song pitch and the capo', () => {
    expect(shiftFret(0, 3, 2, 0)).toEqual({ string: 0, fret: 5 });
    expect(shiftFret(0, 1, -2, 0)).toEqual({ string: 0, fret: 11 });
    expect(shiftFret(2, 5, 0, 3)).toEqual({ string: 2, fret: 5 });
    expect(shiftFret(2, 2, 0, 3)).toEqual({ string: 2, fret: 14 }); // below the capo → an octave up
  });
});

describe('text tabs', () => {
  const am = [
    'e|-----0-----|-0---------|',
    'B|---1---1---|---1-------|',
    'G|-2-------2-|-----2-----|',
    'D|-2---------|-------2---|',
    'A|-0---------|---------0-|',
    'E|-----------|-----------|',
  ].join('\n');

  it('knows a text tab', () => {
    expect(isTextTab(`Вступление\n${am}\nслова`)).toBe(true);
    expect(isTextTab('Раз два три\nчетыре')).toBe(false);
  });

  it('turns it into alphaTex that alphaTab reads', () => {
    const tex = textTabToAlphaTex(am)!;
    const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings());
    const bars = score.tracks[0].staves[0].bars;
    expect(bars).toHaveLength(2);
    const notes = bars[0].voices[0].beats.map((b) => b.notes.map((n) => `${n.fret}/${n.string}`).sort().join('+'));
    // the chord on the 2nd column (G 2, D 2, A 0), then the melody; alphaTab's string 6 = the thinnest
    expect(notes).toEqual(['0/2+2/3+2/4', '1/5', '0/6', '1/5', '2/4']);
    expect(bars[0].voices[0].beats.every((b) => b.duration === alphaTab.model.Duration.Eighth)).toBe(true);
  });

  it('reads two-digit frets and ragged lines', () => {
    const tex = textTabToAlphaTex(['e|--12--|', 'B|------|-', 'G|------|', 'D|------|', 'A|------|---', 'E|------|'].join('\n'))!;
    expect(tex).toContain('12.1');
  });

  it('gives null for text without a tab', () => {
    expect(textTabToAlphaTex('просто текст')).toBeNull();
  });
});

describe('tabBars', () => {
  it('unrolls repeats in playback order with seconds at the tab tempo', () => {
    const settings = new alphaTab.Settings();
    const score = alphaTab.importer.ScoreLoader.loadAlphaTex(
      '\\tempo 90 . :4 0.6 0.6 0.6 0.6 | \\ro 3.6 3.6 3.6 3.6 | \\rc 2 5.6 5.6 5.6 5.6 | 7.6 7.6 7.6 7.6',
      settings,
    );
    const midi = new alphaTab.midi.MidiFile();
    const generator = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(midi));
    generator.generate();
    const lookup = generator.tickLookup.masterBars as unknown as MasterBarTicks[];
    const bars = tabBars(lookup, score.tracks[0], score.tempo);
    expect(bars.map((b) => [b.index, b.occurrence])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
      [3, 0],
    ]);
    expect(bars[1].seconds).toBeCloseTo((4 * 60) / 90);
    expect(bars[3].start).toBeCloseTo((3 * 4 * 60) / 90);
    expect(bars[0].roots).toEqual([4, 4, 4, 4]); // open low E
    expect(bars[1].roots).toEqual([7, 7, 7, 7]); // G on the 3rd fret
  });
});
