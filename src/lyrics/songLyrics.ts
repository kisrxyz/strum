// The open song's lyrics in time: the pasted text parsed, its chords moved to sound like the
// recording (the text's capo, then the key shift), aligned to the heard words and snapped to the
// chord track. Cached for the last song: the panel asks every render, the keys now and then.
import { getLanguage } from '../i18n';
import { effectiveChords } from '../music/track';
import type { Analysis, Song, Transcript } from '../song/types';
import { alignLyrics, chordsFromTrack, snapChords, type TimedLine } from './align';
import { textShift } from './keyShift';
import { parseLyrics, transposeDoc, withCapo, type LyricDoc } from './parse';

export interface SongLyrics {
  /** The text with its chords as they sound in the recording. */
  doc: LyricDoc;
  /** Null when there is nothing to time the lines by yet. */
  lines: TimedLine[] | null;
  /** Semitones the text's chords were moved by to match the recording. */
  shift: number;
  /** The shift was found automatically (not set by the user). */
  autoShift: boolean;
  /** The capo written in the text (its chords were shapes played with it). */
  textCapo: number;
}

let memo: { key: unknown[]; value: SongLyrics | null } | null = null;

export function songLyrics(song: Song | null, analysis: Analysis | null, words: Transcript | null): SongLyrics | null {
  const lyrics = song?.lyrics ?? null;
  if (!song || !lyrics) return null;
  const track = effectiveChords(song, analysis);
  const key = [lyrics, words, track, analysis, song.duration, getLanguage()];
  if (memo && memo.key.length === key.length && memo.key.every((k, i) => k === key[i])) return memo.value;
  const parsed = parseLyrics(lyrics.text);
  const sounding = withCapo(parsed);
  const shift = lyrics.shift ?? textShift(sounding, track);
  const doc = transposeDoc(sounding, shift);
  const aligned = alignLyrics(doc, words?.words ?? [], lyrics.anchors, song.duration);
  // Lyrics without chords of their own take the chord track's.
  const timed = aligned ? chordsFromTrack(doc, snapChords(aligned, track, analysis?.beats ?? []), track) : null;
  const value: SongLyrics = {
    doc: timed?.doc ?? doc,
    lines: timed?.lines ?? null,
    shift,
    autoShift: lyrics.shift === null,
    textCapo: parsed.capo,
  };
  memo = { key, value };
  return value;
}
