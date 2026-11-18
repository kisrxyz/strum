// alphaTab's score → our tab bars in playback order. Uses only the score model and the tick
// lookup alphaTab builds for playback (the same in the browser and in Node tests).
import type { TabBar } from './sync';

/** The parts of alphaTab's MasterBarTickLookup this needs. */
export interface MasterBarTicks {
  masterBar: { index: number };
  start: number;
  end: number;
  tempoChanges: { tick: number; tempo: number }[];
}

/** The parts of a note this needs: its MIDI pitch. */
interface NoteLike {
  realValue: number;
}

/** A track's bars: `staves[0].bars[i].voices[0].beats[j].notes`. */
export interface TrackLike {
  staves: { bars: { voices: { beats: { notes: NoteLike[] }[] }[] }[] }[];
}

/** Ticks per quarter note in alphaTab's MIDI. */
export const TICKS_PER_QUARTER = 960;

/** What a part's line shows: its tab, its notes above the tab, or only its notes. */
export type PartStaves = 'tab' | 'score-tab' | 'score';

/** The parts of a track that say whether it has a tab: alphaTab's `Staff` after reading. */
interface StavesLike {
  staves: { showTablature: boolean; tuning: number[] }[];
}

/**
 * A part with strings is a tab (its notes above it when `notation` is on). Drums have no strings,
 * and keys or a voice may come without a tab: alphaTab draws nothing of them as a tab, so they
 * show as notes. A part not known yet keeps the tab.
 */
export function partStaves(track: StavesLike | null | undefined, notation: boolean): PartStaves {
  const tab = !track || track.staves.some((s) => s.showTablature && s.tuning.length > 0);
  if (!tab) return 'score';
  return notation ? 'score-tab' : 'tab';
}

/** The parts of a track `fixDrumParts` reads and changes: alphaTab's `Track` after reading. */
interface DrumTrackLike {
  playbackInfo: { primaryChannel: number };
  percussionArticulations: unknown[];
  staves: {
    isPercussion: boolean;
    showTablature: boolean;
    tuning: number[];
    bars: { clef: number; voices: { beats: { notes: { fret: number; percussionArticulation: number }[] }[] }[] }[];
  }[];
}

/** alphaTab's `Clef.Neutral`: the drum clef. */
const DRUM_CLEF = 0;

/** MIDI channel 10: the drums. */
const DRUM_CHANNEL = 9;

/** Guitar Pro 5's own drum keys that alphaTab reads as other ones (its `_gp5PercussionInstrumentMap`). */
const GP5_DRUM_KEYS = new Map([
  [27, 42],
  [28, 60],
  [29, 29],
  [30, 30],
  [32, 31],
]);

/**
 * Converters save drums to Guitar Pro 3–5 as a string part on the drum channel: its strings tuned
 * to 0, each fret a drum key. alphaTab reads Guitar Pro's own drum parts as drums but these as a
 * tab of numbers (31, 36, 38). This makes them drum parts the way alphaTab reads the real ones:
 * each note's key becomes its drum (alphaTab looks a key up in its own kit while the part has
 * none of its own). For the picture only: the sound already plays them as drums.
 */
export function fixDrumParts(score: { tracks: DrumTrackLike[] }): void {
  for (const track of score.tracks) {
    if (track.playbackInfo.primaryChannel !== DRUM_CHANNEL || track.percussionArticulations.length) continue;
    const keys = track.staves.every((s) => !s.isPercussion && s.tuning.length > 0 && s.tuning.every((t) => t === 0));
    if (!keys) continue;
    for (const staff of track.staves) {
      staff.isPercussion = true;
      staff.showTablature = false;
      for (const bar of staff.bars) {
        bar.clef = DRUM_CLEF;
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              note.percussionArticulation = GP5_DRUM_KEYS.get(note.fret) ?? note.fret;
              note.fret = Number.NaN;
            }
          }
        }
      }
    }
  }
}

/**
 * Bars in playback order with their start and length in seconds at the tab's tempo, and the
 * roots (lowest note per beat) of `track`.
 */
export function tabBars(lookup: MasterBarTicks[], track: TrackLike | null, startTempo: number): TabBar[] {
  const seen = new Map<number, number>();
  let tempo = startTempo > 0 ? startTempo : 120;
  let time = 0;
  return lookup.map((entry) => {
    if (entry.tempoChanges.length) tempo = entry.tempoChanges[0].tempo;
    const seconds = ((entry.end - entry.start) / TICKS_PER_QUARTER) * (60 / tempo);
    const index = entry.masterBar.index;
    const occurrence = seen.get(index) ?? 0;
    seen.set(index, occurrence + 1);
    const beats = track?.staves[0]?.bars[index]?.voices[0]?.beats ?? [];
    const roots = beats.flatMap((beat) => {
      if (!beat.notes.length) return [];
      const lowest = Math.min(...beat.notes.map((n) => n.realValue));
      return [((lowest % 12) + 12) % 12];
    });
    const bar: TabBar = { index, occurrence, start: time, seconds, roots };
    time += seconds;
    return bar;
  });
}
