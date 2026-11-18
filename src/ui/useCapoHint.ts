import { useMemo } from 'react';
import type { Chord } from '../music/chords';
import { soundingChord } from '../music/display';
import { effectiveChords, visibility } from '../music/track';
import { TUNINGS } from '../music/tunings';
import { suggestCapo } from '../music/voicings';
import { viewOptions } from '../song/chordView';
import type { Analysis, Song } from '../song/types';

/**
 * «Каподастр на 3 — проще»: the capo that makes the song's chords clearly easier (decision 17),
 * or null. Only without a capo and while the fingerings are shown (in «Снять на слух» it would
 * give the chords away).
 */
export function useCapoHint(song: Song, analysis: Analysis | null): { capo: number; saving: number } | null {
  const track = effectiveChords(song, analysis);
  const o = viewOptions(song);
  const fingerings = visibility(song.player.mode, song.player.reveal).fingerings;
  return useMemo(() => {
    if (o.capo !== 0 || !fingerings) return null;
    const weights = new Map<string, { chord: Chord; seconds: number }>();
    for (const seg of track) {
      const sounding = soundingChord(seg.chord, o);
      if (!sounding) continue;
      const k = `${sounding.root}:${sounding.quality}`;
      const entry = weights.get(k) ?? { chord: sounding, seconds: 0 };
      entry.seconds += seg.end - seg.start;
      weights.set(k, entry);
    }
    return suggestCapo([...weights.values()], TUNINGS[o.tuning].strings);
    // o's fields are the dependencies (a new object every render)
  }, [track, o.capo, o.tuning, o.semitones, o.simple, fingerings]);
}
