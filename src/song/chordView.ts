// How the open song's chords are shown: as the shapes you play (capo, tuning, the song's pitch
// shift and «простые аккорды» applied) and back, for edits made in that same view.
import { chordLabel, chordName, parseChord, transposeChord, type Chord } from '../music/chords';
import { shapeChord, shapeSpelling, type ViewOptions } from '../music/display';
import { TUNINGS } from '../music/tunings';
import type { Analysis, ChordLabel, Song } from './types';

export const viewOptions = (song: Song): ViewOptions => ({
  semitones: song.player.semitones,
  capo: song.player.capo,
  tuning: song.player.tuning,
  simple: song.player.simpleChords,
});

/** Semitones from the stored (recorded) chord to the shape: + pitch shift − tuning shift − capo. */
const shapeOffset = (o: ViewOptions) => o.semitones - TUNINGS[o.tuning].shift - o.capo;

/** The stored label for a shape picked in the editor (the inverse of shapeChord, without simplifying). */
export function labelFromShape(shape: Chord | null, o: ViewOptions): ChordLabel {
  return shape ? chordLabel(transposeChord(shape, -shapeOffset(o))) : 'N';
}

/** The shape of a stored label as the editor offers it: transposed, but never simplified. */
export function editableShape(label: ChordLabel, o: ViewOptions): Chord | null {
  const chord = parseChord(label);
  return chord ? transposeChord(chord, shapeOffset(o)) : null;
}

/** Display name of a stored label in the song's view («—» for no chord, «?» for an unknown one). */
export function shapeName(label: ChordLabel, song: Song, analysis: Analysis | null): string {
  if (label === 'X') return '?';
  const o = viewOptions(song);
  return chordName(shapeChord(label, o), shapeSpelling(analysis?.key ?? null, o));
}
