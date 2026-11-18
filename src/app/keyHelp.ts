// What the Keys sheet lists (src/ui/KeysSheet.tsx): every key of keys.ts a person would look up,
// in groups. The words are in the `keys` namespace; `row` names an entry of `keys.rows`.
import type { Dict } from '../i18n';

export type KeyRow = keyof Dict['keys']['rows'];
export type KeyGroup = keyof Dict['keys']['groups'];

export interface KeyHelpGroup {
  group: KeyGroup;
  rows: { keys: string[]; row: KeyRow }[];
}

/** `space` and `stage` in a key list are shown as the current language names them (Space / Пробел, ` / Ё). */
export const KEY_HELP: readonly KeyHelpGroup[] = [
  {
    group: 'playback',
    rows: [
      { keys: ['space'], row: 'playPause' },
      { keys: ['←', '→'], row: 'seek' },
      { keys: ['Shift', '←', '→'], row: 'sections' },
      { keys: ['Home'], row: 'toStart' },
      { keys: ['−', '='], row: 'speed' },
      { keys: [',', '.'], row: 'pitch' },
      { keys: ['End'], row: 'nextSong' },
    ],
  },
  {
    group: 'view',
    rows: [
      { keys: ['W'], row: 'nextView' },
      { keys: ['F'], row: 'fretboard' },
      { keys: ['Shift', 'F'], row: 'fretboardShows' },
      { keys: ['V'], row: 'nextFingering' },
      { keys: ['D'], row: 'degrees' },
      { keys: ["'"], row: 'tabPart' },
      { keys: ['Shift', "'"], row: 'tabNotation' },
      { keys: [';'], row: 'anchor' },
      { keys: ['stage'], row: 'stage' },
    ],
  },
  {
    group: 'chords',
    rows: [
      { keys: ['[', ']'], row: 'capo' },
      { keys: ['U'], row: 'tuning' },
      { keys: ['P'], row: 'simpleChords' },
      { keys: ['Shift', '[', ']'], row: 'barShift' },
      { keys: ['Y'], row: 'toneMatch' },
    ],
  },
  {
    group: 'practice',
    rows: [
      { keys: ['A', 'B'], row: 'loopEdges' },
      { keys: ['R'], row: 'loop' },
      { keys: ['Q'], row: 'loopSection' },
      { keys: ['Z', 'X'], row: 'bookmarks' },
      { keys: ['Shift', 'R'], row: 'repeat' },
      { keys: ['Shift', '='], row: 'speedTrainer' },
      { keys: ['C'], row: 'click' },
      { keys: ['O'], row: 'countIn' },
      { keys: ['H'], row: 'byEar' },
      { keys: ['J'], row: 'hint' },
    ],
  },
  {
    group: 'sound',
    rows: [
      { keys: ['G'], row: 'originalGuitar' },
      { keys: ['S'], row: 'guitarOnly' },
      { keys: ['M'], row: 'mute' },
      { keys: ['↑', '↓'], row: 'volume' },
      { keys: ['Alt', '↑', '↓'], row: 'guitarVolume' },
      { keys: ['Shift', '↑', '↓'], row: 'songVolume' },
      { keys: ['1', '2', '3', '4'], row: 'presets' },
      { keys: ['PgUp', 'PgDn'], row: 'presetsPedal' },
      { keys: ['E'], row: 'backingTrack' },
    ],
  },
  {
    group: 'songs',
    rows: [
      { keys: ['↑', '↓'], row: 'listMove' },
      { keys: ['Enter'], row: 'listPlay' },
      { keys: ['←', '→'], row: 'lists' },
      { keys: ['/'], row: 'search' },
      { keys: ['F'], row: 'favorite' },
      { keys: ['W'], row: 'learning' },
      { keys: ['S'], row: 'setList' },
      { keys: ['R'], row: 'radio' },
      { keys: ['Shift', 'L'], row: 'random' },
      { keys: ['Delete'], row: 'deleteTwice' },
    ],
  },
  {
    group: 'everywhere',
    rows: [
      { keys: ['Esc'], row: 'back' },
      { keys: ['L'], row: 'songsScreen' },
      { keys: ['K'], row: 'ampScreen' },
      { keys: ['I'], row: 'inputScreen' },
      { keys: ['T'], row: 'tuner' },
      { keys: ['G'], row: 'setLevel' },
      { keys: ['\\'], row: 'record' },
      { keys: ['F1'], row: 'keysSheet' },
    ],
  },
];
