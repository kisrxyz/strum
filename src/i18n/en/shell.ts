// Namespace `shell`: the top bar, the start screen, the overlays and the window-wide toasts.
// See ../README.md for the copy rules and the glossary.
export const shell = {
  screens: { song: 'Song', library: 'Songs', amp: 'Amp', input: 'Input' },
  screensLabel: 'Screens',
  presets: 'Presets',
  setlistPlace: (place: number, total: number) => `Set list ${place} of ${total}`,
  radio: 'Radio',
  record: 'Record',
  recordStart: 'Record your playing and the song as you hear them',
  recordStop: 'Stop and save the take',
  tuner: 'Tuner',
  guitarMuted: 'Guitar muted',

  start: {
    label: 'Start the sound',
    starting: 'Starting the sound…',
    /** The button: «Press [Space] to play». */
    pressBefore: 'Press',
    space: 'Space',
    pressAfter: ' to play',
    errors: {
      permission: 'No access to the input. Click the icon left of the address, then Microphone → Allow, then Try again.',
      noDevice: 'No input found. Plug in the guitar cable or the sound card, then press Try again.',
      busy: 'The input is busy in another program, like a call or a DAW. Close it, then press Try again.',
      unsupported: (app: string) => `This browser can't play guitar sound. Open ${app} in Google Chrome.`,
      other: 'The sound did not start.',
    },
  },

  bigTuner: 'Big tuner',
  bigTunerClose: 'Press T or Esc to close',
  dropZone: 'Drop to add: a song (mp3, m4a, wav, flac), a Guitar Pro tab, an amp model (.nam) or a cabinet (.wav)',

  neckShape: 'Fretboard: chord fingering.',
  neckChord: 'Fretboard: every note of the chord.',
  neckScale: 'Fretboard: the whole scale, chord notes large.',
  degreesOn: 'Fretboard shows degrees: 1, ♭3, 5, ♭7.',
  degreesOff: 'Fretboard shows note names.',
  modelAdded: (name: string) => `Amp model “${name}” is in the preset.`,
  cabinetAdded: (name: string) => `Cabinet “${name}” is in the preset.`,
  fileRejected: 'This file does not fit.',
  dropUnknown: (name: string) => `“${name}” is not a song, tab, lyrics, amp model or cabinet.`,

  /** About (src/ui/AboutSheet.tsx). The license texts themselves stay in English. */
  about: {
    open: (app: string) => `About ${app}`,
    version: (v: string) => `Version ${v}`,
    free: 'Free software under the GNU General Public License, version 3. You may use it, share it and change it.',
    local: 'Everything runs on this computer: your songs and recordings are never uploaded.',
    builtOn: 'Built on',
    gpl: 'GNU General Public License, version 3',
    closeHint: 'Esc to close',
  },
};
