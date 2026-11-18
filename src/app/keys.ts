// Keyboard map. Uses physical key codes so it works with any layout (including Russian).
// Some keys depend on the screen: on «Песня» the arrows seek, on «Комбик» they flip presets.
import type { View } from '../state/runtime';

export type Action =
  | 'primary'
  | 'preset1'
  | 'preset2'
  | 'preset3'
  | 'preset4'
  | 'presetPrev'
  | 'presetNext'
  | 'volUp'
  | 'volDown'
  | 'songVolUp'
  | 'songVolDown'
  | 'guitarVolUp'
  | 'guitarVolDown'
  | 'toggleInput'
  | 'toggleTuner'
  | 'toggleLibrary'
  | 'toggleAmp'
  | 'mute'
  | 'back'
  | 'confirm'
  | 'seekBack'
  | 'seekFwd'
  | 'home'
  | 'loopA'
  | 'loopB'
  | 'loopToggle'
  | 'slower'
  | 'faster'
  | 'pitchDown'
  | 'pitchUp'
  | 'centsDown'
  | 'centsUp'
  | 'guitarToggle'
  | 'guitarSolo'
  | 'bookmarkAdd'
  | 'bookmarkNext'
  | 'exportBacking'
  | 'nextModel'
  | 'listUp'
  | 'listDown'
  | 'deleteSong'
  // stage 2: bars, chords, fretboard
  | 'modeToggle'
  | 'hintNext'
  | 'hintsHide'
  | 'clickToggle'
  | 'countInToggle'
  | 'simpleToggle'
  | 'capoDown'
  | 'capoUp'
  | 'barShiftBack'
  | 'barShiftFwd'
  | 'tuningNext'
  | 'fretView'
  | 'neckView'
  | 'degreesToggle'
  | 'voicingNext'
  | 'toneMatchToggle'
  | 'loopSection'
  | 'sectionPrev'
  | 'sectionNext'
  // stage 3: tabs and lyrics
  | 'viewNext'
  | 'anchorHere'
  | 'anchorClear'
  | 'tabTrackNext'
  | 'tabNotation'
  | 'stage'
  // stage 4: solos and fun
  | 'repeatToggle'
  | 'speedTrainer'
  | 'randomSong'
  | 'queueNext'
  | 'libraryTabPrev'
  | 'libraryTabNext'
  | 'favoriteToggle'
  | 'learnToggle'
  | 'setToggle'
  | 'setUp'
  | 'setDown'
  | 'radio'
  | 'searchFocus'
  // «Запись»
  | 'recordToggle'
  // Set input level (G on Input)
  | 'trimListen'
  // The Keys sheet (F1 or ?)
  | 'keys';

type KeyMap = Record<string, Action>;

const GLOBAL: KeyMap = {
  Space: 'primary',
  Digit1: 'preset1',
  Digit2: 'preset2',
  Digit3: 'preset3',
  Digit4: 'preset4',
  Numpad1: 'preset1',
  Numpad2: 'preset2',
  Numpad3: 'preset3',
  Numpad4: 'preset4',
  // Bluetooth pedals send these: presets on every screen.
  PageUp: 'presetPrev',
  PageDown: 'presetNext',
  ArrowUp: 'volUp',
  ArrowDown: 'volDown',
  KeyI: 'toggleInput',
  KeyT: 'toggleTuner',
  KeyL: 'toggleLibrary',
  KeyK: 'toggleAmp',
  KeyM: 'mute',
  Escape: 'back',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  End: 'queueNext',
  // «Запись»: every letter is taken on «Песня», so the key above Enter.
  Backslash: 'recordToggle',
  IntlBackslash: 'recordToggle',
  F1: 'keys',
};

const GLOBAL_SHIFT: KeyMap = {
  ArrowUp: 'songVolUp',
  ArrowDown: 'songVolDown',
  KeyL: 'randomSong',
  // ? on most layouts (Shift+/).
  Slash: 'keys',
};

// Alt+↑ ↓: the guitar alone (↑ ↓ is both, Shift+↑ ↓ the song).
const GLOBAL_ALT: KeyMap = {
  ArrowUp: 'guitarVolUp',
  ArrowDown: 'guitarVolDown',
};

const BY_VIEW: Record<View, KeyMap> = {
  song: {
    ArrowLeft: 'seekBack',
    ArrowRight: 'seekFwd',
    Home: 'home',
    KeyA: 'loopA',
    KeyB: 'loopB',
    KeyR: 'loopToggle',
    Minus: 'slower',
    NumpadSubtract: 'slower',
    Equal: 'faster',
    NumpadAdd: 'faster',
    Comma: 'pitchDown',
    Period: 'pitchUp',
    KeyG: 'guitarToggle',
    KeyS: 'guitarSolo',
    KeyZ: 'bookmarkAdd',
    KeyX: 'bookmarkNext',
    KeyE: 'exportBacking',
    KeyN: 'nextModel',
    KeyH: 'modeToggle',
    KeyJ: 'hintNext',
    KeyC: 'clickToggle',
    KeyO: 'countInToggle',
    KeyP: 'simpleToggle',
    BracketLeft: 'capoDown',
    BracketRight: 'capoUp',
    KeyU: 'tuningNext',
    KeyF: 'fretView',
    KeyD: 'degreesToggle',
    KeyV: 'voicingNext',
    KeyY: 'toneMatchToggle',
    KeyQ: 'loopSection',
    KeyW: 'viewNext',
    Semicolon: 'anchorHere',
    Quote: 'tabTrackNext',
    Backquote: 'stage',
  },
  library: {
    ArrowUp: 'listUp',
    ArrowDown: 'listDown',
    Delete: 'deleteSong',
    ArrowLeft: 'libraryTabPrev',
    ArrowRight: 'libraryTabNext',
    KeyF: 'favoriteToggle',
    KeyW: 'learnToggle',
    KeyS: 'setToggle',
    KeyR: 'radio',
    Slash: 'searchFocus',
  },
  amp: { ArrowLeft: 'presetPrev', ArrowRight: 'presetNext' },
  // G is «П» in the Russian layout: «Подстроить под мою гитару».
  input: { ArrowLeft: 'presetPrev', ArrowRight: 'presetNext', KeyG: 'trimListen' },
};

const BY_VIEW_SHIFT: Partial<Record<View, KeyMap>> = {
  song: {
    Comma: 'centsDown',
    Period: 'centsUp',
    KeyH: 'hintsHide',
    BracketLeft: 'barShiftBack',
    BracketRight: 'barShiftFwd',
    ArrowLeft: 'sectionPrev',
    ArrowRight: 'sectionNext',
    Semicolon: 'anchorClear',
    Quote: 'tabNotation',
    KeyR: 'repeatToggle',
    Equal: 'speedTrainer',
    KeyF: 'neckView',
  },
  library: {
    ArrowUp: 'setUp',
    ArrowDown: 'setDown',
  },
};

export function keyToAction(
  e: { code: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  view: View,
): Action | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.altKey) return e.shiftKey ? null : (GLOBAL_ALT[e.code] ?? null);
  if (e.shiftKey) {
    const shifted = BY_VIEW_SHIFT[view]?.[e.code] ?? GLOBAL_SHIFT[e.code];
    if (shifted) return shifted;
  }
  return BY_VIEW[view][e.code] ?? GLOBAL[e.code] ?? null;
}
