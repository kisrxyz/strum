// The guitar tunings a song can use. Strings are MIDI notes, 6th (lowest) string first.
import { STANDARD_TUNING } from '../dsp/notes';
import { L } from '../i18n';
import type { TuningId } from '../song/types';

export interface Tuning {
  name: string;
  strings: readonly number[];
  /**
   * Semitones between what sounds and the shape you play: shapes are named as played, so in the
   * E♭ tuning an E shape (sounding E♭) is called E. Drop D keeps the names (only the 6th string moves).
   */
  shift: number;
}

/** A tuning whose `name` is read in the current language each time. */
const tuning = (id: TuningId, strings: readonly number[], shift: number): Tuning => ({
  get name() {
    return L().actions.tunings[id];
  },
  strings,
  shift,
});

export const TUNINGS: Record<TuningId, Tuning> = {
  standard: tuning('standard', STANDARD_TUNING, 0),
  eb: tuning('eb', [39, 44, 49, 54, 58, 63], -1),
  dropd: tuning('dropd', [38, 45, 50, 55, 59, 64], 0),
};

/** U goes through them in this order. */
export const TUNING_ORDER: readonly TuningId[] = ['standard', 'eb', 'dropd'];
