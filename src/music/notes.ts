// The notes of the guitar («радар нот»): which note sounds when, the phrases of a solo, note edits.
import type { Analysis, GuitarNote, Song } from '../song/types';

/** A pause at least this long (seconds) ends a phrase. */
export const PHRASE_GAP = 0.6;
/** A phrase has at least this many notes; fewer are stray notes, not a phrase. */
export const PHRASE_MIN_NOTES = 3;
/** What the service accepts for an edited note (MIDI). */
export const NOTE_MIDI_MIN = 28;
export const NOTE_MIDI_MAX = 100;
/** Without beats a phrase loop gets this much air on both sides, seconds. */
const LOOP_AIR = 0.2;
/** Shift+← further than this into a phrase goes back to its own start, like a CD player. */
const RESTART_AFTER = 2;
const STEP_EPSILON = 0.05;

/** A run of notes with short pauses: `first`…`last` are indexes into the notes. */
export interface Phrase {
  start: number;
  end: number;
  first: number;
  last: number;
}

export type NoteEdit = 'up' | 'down' | 'remove';

/** The user's notes when there are any, else the analysis' ones (none in a v1 analysis). */
export function effectiveNotes(song: Song, analysis: Analysis | null): GuitarNote[] {
  return song.guitarNotes ?? analysis?.notes ?? [];
}

/** Index of the last note starting at or before `t`, −1 before the first. Notes are sorted by start. */
function lastStartingBy(notes: readonly GuitarNote[], t: number): number {
  let lo = 0;
  let hi = notes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Index of the note sounding at `t`, −1 in a pause. */
export function noteAt(notes: readonly GuitarNote[], t: number): number {
  const i = lastStartingBy(notes, t);
  return i >= 0 && t < notes[i].end ? i : -1;
}

/** Index of the first note starting after `t`, −1 when none does. */
export function nextNote(notes: readonly GuitarNote[], t: number): number {
  const i = lastStartingBy(notes, t) + 1;
  return i < notes.length ? i : -1;
}

/** The notes split at pauses of `gap` seconds and more; runs of fewer than `min` notes are left out. */
export function phrases(notes: readonly GuitarNote[], gap = PHRASE_GAP, min = PHRASE_MIN_NOTES): Phrase[] {
  const out: Phrase[] = [];
  let first = 0;
  let end = notes.length ? notes[0].end : 0;
  const close = (last: number) => {
    if (last - first + 1 >= min) out.push({ start: notes[first].start, end, first, last });
  };
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].start - end >= gap) {
      close(i - 1);
      first = i;
    }
    end = Math.max(end, notes[i].end);
  }
  if (notes.length) close(notes.length - 1);
  return out;
}

/** Index of the phrase `t` is in, −1 between phrases. */
export function phraseAt(list: readonly Phrase[], t: number): number {
  return list.findIndex((p) => p.start <= t && t < p.end);
}

/**
 * Shift+→ / Shift+← in the «Ноты» view: index of the phrase to go to, −1 when there is none. Back
 * from more than two seconds into a phrase goes to its own start first.
 */
export function stepPhrase(list: readonly Phrase[], t: number, dir: 1 | -1): number {
  if (dir > 0) return list.findIndex((p) => p.start > t + STEP_EPSILON);
  const current = phraseAt(list, t);
  if (current >= 0) return t - list[current].start > RESTART_AFTER ? current : Math.max(0, current - 1);
  let before = -1;
  list.forEach((p, i) => {
    if (p.start < t) before = i;
  });
  return before;
}

/**
 * Q: the loop around a phrase, from the beat at or before its first note to the beat at or after its
 * last one (so the loop keeps the song's pulse). Without beats: a little air on both sides.
 */
export function phraseLoop(phrase: Phrase, beats: readonly number[]): { start: number; end: number } {
  let start: number | null = null;
  let end: number | null = null;
  for (const beat of beats) {
    if (beat <= phrase.start) start = beat;
    if (beat >= phrase.end && end === null) end = beat;
  }
  return {
    start: start ?? Math.max(0, phrase.start - LOOP_AIR),
    end: end ?? phrase.end + LOOP_AIR,
  };
}

/** A note moved a semitone up or down, or removed. Only start, end and midi are kept (what song.json stores). */
export function editNote(notes: readonly GuitarNote[], index: number, edit: NoteEdit): GuitarNote[] {
  const plain = notes.map(({ start, end, midi }) => ({ start, end, midi }));
  if (index < 0 || index >= plain.length) return plain;
  if (edit === 'remove') return plain.filter((_, i) => i !== index);
  const step = edit === 'up' ? 1 : -1;
  const midi = Math.max(NOTE_MIDI_MIN, Math.min(NOTE_MIDI_MAX, plain[index].midi + step));
  return plain.map((note, i) => (i === index ? { ...note, midi } : note));
}

/**
 * The usual range of the notes, for the lane's height: the lowest and highest after leaving out the
 * outer `trim` share at each end (a stray low or high note is pinned to the edge, not given rows),
 * widened to at least `minSpan` semitones around its middle. Null without notes.
 */
export function noteRange(notes: readonly GuitarNote[], trim = 0.03, minSpan = 12): { low: number; high: number } | null {
  if (!notes.length) return null;
  const sorted = notes.map((n) => n.midi).sort((a, b) => a - b);
  const last = sorted.length - 1;
  let low = sorted[Math.floor(trim * last)];
  let high = sorted[Math.ceil((1 - trim) * last)];
  if (high - low < minSpan) {
    const middle = (low + high) / 2;
    low = Math.floor(middle - minSpan / 2);
    high = low + minSpan;
  }
  return { low, high };
}
