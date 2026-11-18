// Putting pasted lyrics in time. The service hears the words of the vocal stem (Whisper, with
// times); here the pasted words are matched to the heard ones (a global alignment, so a misheard
// or missing word does not shift the rest), matched words take the heard times, the others are
// placed between them by their position in the text. User anchors («;» — this line starts now)
// and the times of an .lrc file win over what was heard. Then each chord takes the time of the
// word it stands over and moves to the chord change the analysis found nearby.
import { parseChord } from '../music/chords';
import type { ChordLabel, ChordSegment } from '../song/types';
import type { LyricDoc } from './parse';

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

/** «This line starts at `time`» — set by the user with «;». */
export interface Anchor {
  line: number;
  time: number;
}

export interface TimedLine {
  /** Index in `doc.lines`. */
  line: number;
  start: number;
  end: number;
  /** The line's words: character range in its text and time. */
  words: { from: number; to: number; start: number; end: number }[];
  chords: { at: number; label: ChordLabel; time: number }[];
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
/** Matched words this similar (and at least this long) become time anchors. */
const MIN_SIMILARITY = 0.6;
const MIN_ANCHOR_LENGTH = 3;
const GAP = -0.15;
/** Characters per second when there is nothing better to go by (sung text). */
const DEFAULT_RATE = 12;
const MIN_STEP = 0.05;
/** A chord moves to a change of the chord track with the same root at most this far, seconds. */
const SNAP_SECONDS = 1.5;

/** Lower case, ё → е, letters and digits only. */
export const normWord = (word: string): string =>
  word.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, ''); // ё → е, escaped

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 for equal words, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - levenshtein(a, b) / longest : 0;
}

interface DocWord {
  line: number;
  from: number;
  to: number;
  norm: string;
  /** Position in the whole text (characters of the sung lines only). */
  pos: number;
}

/** Pairs (doc word index → heard word index) of a global alignment with free leading and trailing heard words. */
export function matchWords(doc: string[], heard: string[]): [number, number][] {
  const n = doc.length;
  const m = heard.length;
  if (!n || !m || n * m > 6_000_000) return [];
  const width = m + 1;
  const score = new Float32Array((n + 1) * width);
  const from = new Uint8Array((n + 1) * width); // 0 diagonal, 1 skip a doc word, 2 skip a heard word
  const sim = (i: number, j: number) => similarity(doc[i], heard[j]);
  for (let i = 1; i <= n; i++) {
    score[i * width] = i * GAP;
    from[i * width] = 1;
  }
  for (let j = 1; j <= m; j++) from[j] = 2; // heard words before the text cost nothing
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * width + j - 1] + sim(i - 1, j - 1) - 0.5;
      const up = score[(i - 1) * width + j] + GAP;
      const left = score[i * width + j - 1] + (i === n ? 0 : GAP); // and after it
      let best = diag;
      let way = 0;
      if (up > best) {
        best = up;
        way = 1;
      }
      if (left > best) {
        best = left;
        way = 2;
      }
      score[i * width + j] = best;
      from[i * width + j] = way;
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const way = from[i * width + j];
    if (way === 0) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (way === 1) i--;
    else j--;
  }
  return pairs.reverse();
}

interface Point {
  pos: number;
  time: number;
}

/** Adds points by priority, skipping any that would make time go backwards against the kept ones. */
function consistent(groups: Point[][]): Point[] {
  const kept: Point[] = [];
  for (const group of groups) {
    for (const p of group) {
      let k = 0;
      while (k < kept.length && kept[k].pos < p.pos) k++;
      if (k < kept.length && kept[k].pos === p.pos) continue;
      const before = kept[k - 1];
      const after = kept[k];
      if ((before && before.time >= p.time) || (after && after.time <= p.time)) continue;
      kept.splice(k, 0, p);
    }
  }
  return kept;
}

function interpolator(points: Point[], duration: number): (pos: number) => number {
  const first = points[0];
  const last = points[points.length - 1];
  let rate = DEFAULT_RATE;
  if (points.length >= 2 && last.time > first.time) {
    rate = Math.min(30, Math.max(5, (last.pos - first.pos) / (last.time - first.time)));
  }
  return (pos: number) => {
    if (pos <= first.pos) return Math.max(0, first.time - (first.pos - pos) / rate);
    if (pos >= last.pos) return Math.min(duration, last.time + (pos - last.pos) / rate);
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].pos <= pos) lo = mid;
      else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    return a.time + ((pos - a.pos) / (b.pos - a.pos)) * (b.time - a.time);
  };
}

/**
 * The doc's lines in time, or null when there is nothing to time them by (no heard words, no
 * .lrc times, fewer than two anchors).
 */
export function alignLyrics(doc: LyricDoc, heard: TimedWord[], anchors: Anchor[], duration: number): TimedLine[] | null {
  const lrcTimes = doc.lines.map((l) => l.time).filter((t): t is number => t !== null);
  const userAnchors = anchors.filter((a) => a.line >= 0 && a.line < doc.lines.length);
  if (!heard.length && !lrcTimes.length && userAnchors.length < 2) return null;

  // The sung lines' words, with their positions in the whole text.
  const words: DocWord[] = [];
  const lineStart: number[] = [];
  let pos = 0;
  doc.lines.forEach((line, index) => {
    lineStart[index] = pos;
    for (const m of line.text.matchAll(WORD)) {
      const norm = normWord(m[0]);
      if (!norm) continue;
      const from = m.index ?? 0;
      words.push({ line: index, from, to: from + m[0].length, norm, pos: pos + from });
    }
    if (line.text.trim()) pos += line.text.length + 1;
  });
  const total = pos;

  const heardSorted = [...heard].sort((a, b) => a.start - b.start);
  const heardNorm = heardSorted.map((w) => normWord(w.word));
  const matched = new Map<number, TimedWord>();
  for (const [i, j] of matchWords(
    words.map((w) => w.norm),
    heardNorm,
  )) {
    const a = words[i].norm;
    const b = heardNorm[j];
    if (Math.max(a.length, b.length) >= MIN_ANCHOR_LENGTH && similarity(a, b) >= MIN_SIMILARITY) matched.set(i, heardSorted[j]);
  }

  const firstWordOf = (line: number) => words.find((w) => w.line === line);
  const linePos = (line: number) => firstWordOf(line)?.pos ?? lineStart[line];
  const user = userAnchors.map((a) => ({ pos: linePos(a.line), time: a.time }));
  const lrc = doc.lines.flatMap((l, index) => (l.time !== null && l.text.trim() ? [{ pos: linePos(index), time: l.time }] : []));
  const fromWords = [...matched].map(([i, w]) => ({ pos: words[i].pos, time: w.start }));
  const span =
    heardSorted.length && words.length
      ? [
          { pos: words[0].pos, time: heardSorted[0].start },
          { pos: total, time: heardSorted[heardSorted.length - 1].end },
        ]
      : [];
  const points = consistent([user, lrc, fromWords, span]);
  if (!points.length) return null;
  const timeAt = interpolator(points, duration);

  // Every word's time: heard when matched (and still consistent), placed otherwise.
  const pinned = new Map(points.map((p) => [p.pos, p.time]));
  const wordTimes = words.map((w, i) => {
    const start = pinned.get(w.pos) ?? timeAt(w.pos);
    const heardWord = matched.get(i);
    const end = heardWord && pinned.get(w.pos) === heardWord.start ? heardWord.end : timeAt(w.pos + (w.to - w.from));
    return { start, end: Math.max(start, end) };
  });

  const lines: TimedLine[] = doc.lines.map((_line, index) => {
    const own = words.map((w, i) => ({ w, t: wordTimes[i] })).filter(({ w }) => w.line === index);
    return {
      line: index,
      start: own.length ? own[0].t.start : Number.NaN,
      end: Number.NaN,
      words: own.map(({ w, t }) => ({ from: w.from, to: w.to, start: t.start, end: t.end })),
      chords: [],
    };
  });

  // Lines without words (instrumental parts, and lyric lines of symbols only) fill the gaps.
  for (let i = 0; i < lines.length; ) {
    if (!Number.isNaN(lines[i].start)) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && Number.isNaN(lines[j].start)) j++;
    const before = lines[i - 1];
    const after = lines[j];
    const lastEnd = before ? Math.max(before.start, ...before.words.map((w) => w.end)) : 0;
    const gapStart = before ? Math.min(lastEnd + 0.2, after ? after.start : duration) : 0;
    const gapEnd = after ? after.start : duration;
    const step = (gapEnd - gapStart) / (j - i);
    for (let k = i; k < j; k++) lines[k].start = gapStart + (k - i) * step;
    i = j;
  }

  // Strictly increasing starts inside the song; each line ends where the next one starts.
  for (let i = 0; i < lines.length; i++) {
    const min = i ? lines[i - 1].start + MIN_STEP : 0;
    lines[i].start = Math.min(Math.max(lines[i].start, min), duration);
  }
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const lastWord = lines[i].words.length ? lines[i].words[lines[i].words.length - 1].end : lines[i].start;
    lines[i].end = next ? Math.max(next.start, lines[i].start) : Math.min(duration, Math.max(lines[i].start + 1, lastWord + 2));
  }

  // Each chord takes the time of the word it stands over.
  for (const timed of lines) {
    const line = doc.lines[timed.line];
    const n = line.chords.length;
    timed.chords = line.chords.map((chord, k) => {
      const ws = timed.words;
      if (!ws.length) return { at: chord.at, label: chord.label, time: timed.start + (k / Math.max(1, n)) * (timed.end - timed.start) };
      const inside = ws.find((w) => chord.at >= w.from && chord.at < w.to);
      let time: number;
      if (inside) time = inside.start + ((chord.at - inside.from) / (inside.to - inside.from)) * (inside.end - inside.start);
      else {
        const nextWord = ws.find((w) => w.from >= chord.at);
        if (nextWord) time = chord.at < ws[0].from ? timed.start : nextWord.start;
        else {
          const last = ws[ws.length - 1];
          time = Math.min(timed.end - MIN_STEP, last.end + (chord.at - last.to) * 0.15);
        }
      }
      return { at: chord.at, label: chord.label, time: Math.max(timed.start, time) };
    });
  }
  return lines;
}

/**
 * Chords moved to the chord track: to the nearest change into a chord with the same root within
 * 1.5 s, else to the nearest beat within half a beat. Order inside a line is kept.
 */
export function snapChords(lines: TimedLine[], track: ChordSegment[], beats: number[]): TimedLine[] {
  const changes = track.flatMap((seg) => {
    const chord = parseChord(seg.chord);
    return chord ? [{ time: seg.start, root: chord.root }] : [];
  });
  const nearestBeat = (t: number): number => {
    if (beats.length < 2) return t;
    let lo = 0;
    let hi = beats.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid;
    }
    const b = Math.abs(beats[lo] - t) <= Math.abs(beats[hi] - t) ? lo : hi;
    const interval = beats[Math.min(b + 1, beats.length - 1)] - beats[Math.max(b - 1, 0)];
    const half = interval / (b > 0 && b < beats.length - 1 ? 4 : 2);
    return Math.abs(beats[b] - t) <= half ? beats[b] : t;
  };
  return lines.map((line) => {
    let previous = -Infinity;
    const chords = line.chords.map((c) => {
      const root = parseChord(c.label)?.root;
      let best: number | null = null;
      for (const change of changes) {
        if (change.root !== root || Math.abs(change.time - c.time) > SNAP_SECONDS) continue;
        if (best === null || Math.abs(change.time - c.time) < Math.abs(best - c.time)) best = change.time;
      }
      const time = Math.max(previous, best ?? nearestBeat(c.time));
      previous = time;
      return { ...c, time };
    });
    return { ...line, chords };
  });
}

/**
 * Lyrics without chords (.lrc, LRCLIB, plain text, the draft from the vocals) get the chord
 * track's chords: the one sounding when a line starts goes over its first letter, every change
 * inside the line over the word sung then.
 */
export function chordsFromTrack(doc: LyricDoc, lines: TimedLine[], track: ChordSegment[]): { doc: LyricDoc; lines: TimedLine[] } {
  if (doc.lines.some((l) => l.chords.length) || !track.length) return { doc, lines };
  const sounding = (t: number) => track.find((seg) => seg.start <= t && t < seg.end);
  const docLines = doc.lines.map((l) => ({ ...l, chords: [...l.chords] }));
  const timed = lines.map((line) => {
    const text = docLines[line.line].text;
    if (!text.trim()) return line;
    const chords: TimedLine['chords'] = [];
    const add = (label: ChordLabel, time: number) => {
      if (!parseChord(label) || chords[chords.length - 1]?.label === label) return;
      // the word being sung at `time` (the first one before the line's first word)
      let at = 0;
      for (const w of line.words) if (w.start <= time) at = w.from;
      chords.push({ at: Math.min(at, text.length), label, time });
    };
    const first = sounding(line.start);
    if (first) add(first.chord, line.start);
    for (const seg of track) if (seg.start > line.start && seg.start < line.end) add(seg.chord, seg.start);
    docLines[line.line].chords = chords.map((c) => ({ at: c.at, label: c.label, text: c.label }));
    return { ...line, chords };
  });
  return { doc: { ...doc, lines: docLines }, lines: timed };
}

/** Index of the line sung at `t` (−1 before the first). */
export function lineAt(lines: TimedLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
