import { describe, expect, it } from 'vitest';
import { QUALITIES, chordIntervals, chordLabel, parseChord, type Chord } from './chords';
import { TUNINGS } from './tunings';
import { suggestCapo, voicings, type Voicing } from './voicings';

const STANDARD = TUNINGS.standard.strings;
const plus = (strings: readonly number[], capo: number) => strings.map((m) => m + capo);

function chord(label: string): Chord {
  const c = parseChord(label);
  if (!c) throw new Error(`bad label ${label}`);
  return c;
}
const first = (label: string, open: readonly number[] = STANDARD): Voicing => voicings(chord(label), open)[0];

const ALL_CHORDS: Chord[] = Array.from({ length: 12 }, (_, root) => QUALITIES.map((quality) => ({ root, quality }))).flat();

/** Everything a voicing must be, whatever the chord: playable and made of its notes only. */
function checkVoicing(v: Voicing, c: Chord, open: readonly number[]): void {
  const where = `${chordLabel(c)} ${JSON.stringify(v.frets)}`;
  const intervals = chordIntervals(c.quality);
  const tones = intervals.map((i) => (c.root + i) % 12);
  const sounding = v.frets.flatMap((f, s) => (f < 0 ? [] : [(open[s] + f) % 12]));
  expect(v.frets, where).toHaveLength(open.length);
  expect(sounding.every((pc) => tones.includes(pc)), `${where}: only chord tones`).toBe(true);
  expect(sounding, `${where}: root`).toContain(c.root);
  const third = intervals.find((i) => i === 3 || i === 4);
  if (third !== undefined) expect(sounding, `${where}: third`).toContain((c.root + third) % 12);
  const fretted = v.frets.filter((f) => f > 0);
  if (fretted.length) expect(Math.max(...fretted) - Math.min(...fretted), `${where}: span`).toBeLessThanOrEqual(3);
  const used = new Set(v.fingers.filter((f) => f > 0));
  expect(used.size, `${where}: fingers`).toBeLessThanOrEqual(4);
  expect(Math.max(0, ...v.fingers), `${where}: finger numbers`).toBeLessThanOrEqual(4);
  v.frets.forEach((f, s) => expect(v.fingers[s] > 0, `${where}: finger on string ${s}`).toBe(f > 0));
  if (v.barre) {
    expect(v.barre.fret, `${where}: barre at the lowest fret`).toBe(Math.min(...fretted));
    for (let s = v.barre.from; s <= v.barre.to; s++) expect(v.frets[s], `${where}: under the barre`).toBeGreaterThanOrEqual(v.barre.fret);
  }
  // a chord box of four frets from baseFret holds every fretted note
  for (const f of fretted) expect(f - v.baseFret, `${where}: box`).toBeLessThan(4);
}

describe('voicings in standard tuning', () => {
  it.each<[string, number[]]>([
    ['C', [-1, 3, 2, 0, 1, 0]],
    ['A', [-1, 0, 2, 2, 2, 0]],
    ['D', [-1, -1, 0, 2, 3, 2]],
    ['E', [0, 2, 2, 1, 0, 0]],
    ['A:min', [-1, 0, 2, 2, 1, 0]],
    ['E:min', [0, 2, 2, 0, 0, 0]],
    ['D:min', [-1, -1, 0, 2, 3, 1]],
    ['B:min', [-1, 2, 4, 4, 3, 2]],
    ['F#:min', [2, 4, 4, 2, 2, 2]],
    ['Bb', [-1, 1, 3, 3, 3, 1]],
    ['B:7', [-1, 2, 1, 2, 0, 2]],
    ['A:7', [-1, 0, 2, 0, 2, 0]],
    ['D:7', [-1, -1, 0, 2, 1, 2]],
  ])('%s starts with %j', (label, frets) => {
    expect(first(label).frets).toEqual(frets);
  });

  it('G is the open G', () => {
    expect([
      [3, 2, 0, 0, 0, 3],
      [3, 2, 0, 0, 3, 3],
    ]).toContainEqual(first('G').frets);
  });

  it('F is the full barre at the first fret, fingered like a chord book', () => {
    const f = first('F');
    expect(f.frets).toEqual([1, 3, 3, 2, 1, 1]);
    expect(f.barre).toEqual({ fret: 1, from: 0, to: 5 });
    expect(f.fingers).toEqual([1, 3, 4, 2, 1, 1]);
    expect(f.baseFret).toBe(1);
  });

  it('fingers the open chords like a chord book', () => {
    expect(first('C').fingers).toEqual([0, 3, 2, 0, 1, 0]);
    expect(first('C').barre).toBeNull();
    expect(first('D').fingers).toEqual([0, 0, 0, 1, 3, 2]);
    expect(first('E').fingers).toEqual([0, 2, 3, 1, 0, 0]);
    expect(first('A:min').fingers).toEqual([0, 0, 2, 3, 1, 0]);
    expect(first('B:7').fingers).toEqual([0, 2, 1, 3, 0, 4]);
    expect(first('B:min').fingers).toEqual([0, 1, 3, 4, 2, 1]);
    expect(first('B:min').barre).toEqual({ fret: 2, from: 1, to: 5 });
  });

  it('E7 has the two-finger shape among the first two', () => {
    const list = voicings(chord('E:7'), STANDARD).slice(0, 2).map((v) => v.frets);
    expect(list).toContainEqual([0, 2, 0, 1, 0, 0]);
  });

  it('gives different positions, easiest first, at most max', () => {
    const list = voicings(chord('C'), STANDARD);
    expect(list.length).toBeGreaterThan(1);
    expect(list.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < list.length; i++) expect(list[i].difficulty).toBeGreaterThanOrEqual(list[i - 1].difficulty);
    const lowestFret = (v: Voicing) => Math.min(...v.frets.filter((f) => f > 0));
    expect(new Set(list.map(lowestFret)).size).toBe(list.length);
    expect(voicings(chord('C'), STANDARD, 2)).toHaveLength(2);
    expect(voicings(chord('C'), STANDARD, 0)).toEqual([]);
  });

  it('a box starts at the first fret only when the shape fits there', () => {
    const list = voicings(chord('C'), STANDARD);
    const high = list.find((v) => Math.max(...v.frets) > 4);
    expect(high).toBeDefined();
    expect(high!.baseFret).toBe(Math.min(...high!.frets.filter((f) => f > 0)));
  });

  it('every chord of the dictionary gets playable voicings of its own notes', () => {
    for (const c of ALL_CHORDS) {
      const list = voicings(c, STANDARD);
      expect(list.length, chordLabel(c)).toBeGreaterThan(0);
      for (const v of list) checkVoicing(v, c, STANDARD);
    }
  });
});

describe('voicings in other tunings and with a capo', () => {
  it('E♭ in the E♭ tuning is the E shape', () => {
    expect(first('D#', TUNINGS.eb.strings).frets).toEqual([0, 2, 2, 1, 0, 0]);
  });

  it('D in drop D rings the open 6th string', () => {
    expect(first('D', TUNINGS.dropd.strings).frets[0]).toBe(0);
  });

  it('A with a capo on 2 is the G shape, frets counted from the capo', () => {
    expect([
      [3, 2, 0, 0, 0, 3],
      [3, 2, 0, 0, 3, 3],
    ]).toContainEqual(first('A', plus(STANDARD, 2)).frets);
  });

  it('every chord gets voicings in drop D and with a capo on 7', () => {
    for (const open of [TUNINGS.dropd.strings, plus(STANDARD, 7)]) {
      for (const c of ALL_CHORDS) {
        const list = voicings(c, open, 2);
        expect(list.length, chordLabel(c)).toBeGreaterThan(0);
        for (const v of list) checkVoicing(v, c, open);
      }
    }
  });
});

describe('suggestCapo', () => {
  const song = (labels: string[]) => labels.map((label) => ({ chord: chord(label), seconds: 10 }));

  it('suggests the capo that turns barre chords into open ones', () => {
    expect(suggestCapo(song(['Bb', 'G:min', 'D#', 'F']), STANDARD)).toMatchObject({ capo: 3 });
    expect(suggestCapo(song(['Bb', 'G:min', 'D#', 'F']), STANDARD)!.saving).toBeGreaterThan(0);
  });

  it('stays quiet when the chords are easy already', () => {
    expect(suggestCapo(song(['C', 'G', 'A:min', 'F']), STANDARD)).toBeNull();
    expect(suggestCapo(song(['E', 'A', 'D']), STANDARD)).toBeNull();
    expect(suggestCapo([], STANDARD)).toBeNull();
  });
});
