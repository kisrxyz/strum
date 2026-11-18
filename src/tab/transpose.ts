// The tab follows the song's pitch shift and the capo: frets move by the semitones, the capo is
// taken off (frets counted from it), a note that would fall below it goes up an octave.

/** `string` 0 = the lowest string, as on our fretboard; `fret` from the nut. */
export function shiftFret(string: number, fret: number, semitones: number, capo: number): { string: number; fret: number } {
  let shifted = fret + semitones - capo;
  while (shifted < 0) shifted += 12;
  while (shifted > 24) shifted -= 12;
  return { string, fret: shifted + capo };
}
