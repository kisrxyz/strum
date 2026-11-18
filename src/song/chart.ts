// «Аккорды» as a songbook chart: rows of bars, a new row where a song section starts, each chord
// written at the beat it starts on. Pure logic for `ChordChart`.
import { sectionLabel } from './sections';
import type { Bar } from '../music/bars';
import type { ChordSegment, Section } from './types';

export interface ChartChord {
  /** The beat of the bar the chord is written at (0 = the bar's first beat). */
  beat: number;
  /** Index into the chord track. */
  index: number;
}

export interface ChartBar {
  number: number;
  start: number;
  end: number;
  /** Beats in this bar (the beat marks under it). */
  beats: number;
  chords: ChartChord[];
}

export interface ChartRow {
  /** The section's name on the row it starts; null on the rows after. */
  section: string | null;
  bars: ChartBar[];
}

/** A chord starting this close after a bar line still counts as on its first beat, seconds. */
const EDGE = 0.05;

/** The beat of `bar` nearest to `t`. */
function beatOf(bar: Bar, t: number): number {
  let best = 0;
  bar.beats.forEach((b, i) => {
    if (Math.abs(b - t) < Math.abs(bar.beats[best] - t)) best = i;
  });
  return best;
}

/** The chords written in `bar`: the one sounding at its start, then each change inside it. */
function barChords(bar: Bar, track: ChordSegment[]): ChartChord[] {
  const out: ChartChord[] = [];
  let last: string | null = null;
  track.forEach((seg, index) => {
    if (seg.end <= bar.start + EDGE || seg.start >= bar.end - EDGE) return;
    const beat = seg.start <= bar.start + EDGE ? 0 : beatOf(bar, seg.start);
    if (seg.chord === 'N') {
      last = null;
      return;
    }
    if (seg.chord === last) return;
    last = seg.chord;
    // Two changes landing on one beat: the later one is what sounds there.
    if (out.length && out[out.length - 1].beat === beat) out.pop();
    out.push({ beat, index });
  });
  return out;
}

/** The section that `t` falls in. */
function sectionAt(sections: Section[], t: number): Section | null {
  return sections.find((s) => t >= s.start - EDGE && t < s.end - EDGE) ?? null;
}

export function chartRows(bars: Bar[], track: ChordSegment[], sections: Section[], perRow = 4, fromFile = false): ChartRow[] {
  const rows: ChartRow[] = [];
  let current: ChartRow | null = null;
  let currentSection: Section | null | undefined;
  for (const bar of bars) {
    if (bar.number < 1) continue;
    const s = sectionAt(sections, bar.start);
    const newSection = s !== currentSection;
    if (!current || newSection || current.bars.length >= perRow) {
      current = { section: newSection && s ? sectionLabel(sections, sections.indexOf(s), fromFile) : null, bars: [] };
      rows.push(current);
      currentSection = s;
    }
    current.bars.push({
      number: bar.number,
      start: bar.start,
      end: bar.end,
      beats: Math.max(1, bar.beats.length),
      chords: barChords(bar, track),
    });
  }
  return rows;
}

/** The row that time `t` is in: the first before the song's first bar, the last after its end. */
export function rowAt(rows: ChartRow[], t: number): number {
  if (!rows.length) return -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].bars[0].start <= t) return i;
  return 0;
}
