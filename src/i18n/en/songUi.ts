// Namespace `songUi`: the song screen and the panels on it (src/ui/SongScreen.tsx, Transport,
// Mixer, SongSettings, the lyrics, tab, chord and note views and editors, «Сцена», printing).
// See ../README.md for the copy rules and the glossary.
export const songUi = {
  /** While the tab view (alphaTab) loads for the first time. */
  tabOpening: 'Opening the tab…',
  views: { lyrics: 'Lyrics', chords: 'Chords', tab: 'Tab', notes: 'Notes' },
  view: 'View',
  nextView: 'Next view',
  /** What comes after the one sounding now: «дальше Am». */
  next: (name: string) => `next ${name}`,
  prevItem: '← Previous',
  nextItem: 'Next →',
  restore: 'Restore',
  print: 'Print',
  unknownError: 'unknown error',
  /** Key names that differ by language. */
  spaceKey: 'Space',
  stageKey: '`',

  // The names of the switches, the same in the bottom row, its tooltips and Settings.
  speed: 'Speed',
  pitch: 'Pitch',
  loop: 'Loop',
  loopSection: 'Loop this section',
  capo: 'Capo',
  tuning: 'Tuning',
  simpleChords: 'Simple chords',
  click: 'Click',
  countIn: 'Count-in',
  originalGuitar: 'Original guitar',
  guitarOnly: 'Guitar only',
  repeat: 'Repeat after me',
  trainer: 'Speed trainer',
  hint: 'Hint',
  fretboard: 'Fretboard',
  stems: 'Stems',
  settings: 'Settings',
  matchTone: 'Match song tone',
  stageView: 'Stage view',
  exportBacking: 'Export backing track',
  stemModel: 'Stem model',
  nextModel: 'Next model',
  nextPart: 'Next part',
  /** Play by ear: how much of the chords is shown, by hint level 0–3. */
  hintsShort: ['hidden', 'changes', 'current', 'all'],
  hintsLong: ['all hidden', 'chord changes', 'current chord', 'all chords'],
  stemNames: { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Keys', other: 'Other' },

  offline: {
    title: 'Songs are unavailable',
    text: (app: string) => `The amp works, but songs can't be opened right now. Restart ${app}.`,
  },
  empty: {
    pickTitle: 'Pick a song',
    pickText: 'Open the song list (L).',
    addTitle: 'Add a song',
    addText:
      'Drop an audio file (mp3, m4a, wav, flac) or a Guitar Pro tab here. The song plays without its guitar, and you play that part.',
  },

  neck: {
    tabNotes: 'Tab notes',
    tabNote: 'Tab note',
    recordingNote: 'Note in the recording',
    fingeringOf: (n: number, of: number) => `fingering ${n} of ${of}`,
    nextFingering: 'Next fingering',
  },
  neckViews: { shape: 'fingering', chord: 'all chord notes', scale: 'whole scale' },

  transport: {
    label: 'Song controls',
    play: 'Play',
    pause: 'Pause',
    bar: (n: number) => `bar ${n}`,
    speedTip: 'Slower / faster',
    pitchTip: 'Semitone down / up',
    centsTip: 'Cents',
    clickToReset: 'Click to reset.',
    loopFrom: (time: string) => `from ${time}…`,
    loopEnds: 'Loop start / end',
    loopOnOff: 'Loop on / off',
    repeatListen: 'Repeat: listen',
    repeatPlay: 'Repeat: play',
    trainerTip: 'Each pass 5% faster',
    byEar: (hint: string) => `By ear · ${hint}`,
    nextHint: 'Next hint',
    capoOn: (n: number) => `Capo ${n}`,
    capoEasier: (n: number) => `Capo ${n} is easier`,
    neckShows: 'What it shows',
    stemsTip: 'Stem volumes and backing track',
    settingsTip: 'All song switches',
  },

  options: {
    label: 'Song settings',
    groupPlaying: 'Playing',
    groupChords: 'Chords and fretboard',
    groupSound: 'Sound',
    mode: 'Mode',
    modePlay: 'play',
    modeEar: 'by ear',
    capoValue: (n: number) => `fret ${n}`,
    neckShows: 'Fretboard shows',
    degrees: 'Scale degrees',
    guitarPlays: 'on',
    guitarSilent: 'off',
    bookmarkLoop: 'Bookmark the loop',
    nextBookmark: 'Next bookmark',
    deleteBookmark: (name: string) => `Delete “${name}”`,
  },

  mixer: {
    separating: (pct: number) => `Separating: ${pct}%`,
    waiting: 'Waiting to separate…',
    failed: 'Separation failed.',
    notSeparated: 'Not separated into stems yet.',
    wholeSongPlays: 'The whole song plays until then.',
    separate: 'Separate into stems',
    yourPart: 'Your part',
    you: 'you',
    original: 'original',
    volumeOf: (name: string) => `Volume: ${name}`,
    mute: 'Mute',
    solo: 'Solo',
    muteTip: 'Mute this stem',
    soloTip: 'Play only this stem',
    guitar: 'Guitar',
    song: 'Song',
    guitarVolume: 'Guitar volume',
    songVolume: 'Song volume',
    tabPartHint: 'Your part is the part on screen',
  },

  lyrics: {
    instrumental: 'instrumental',
    edit: 'Edit lyrics',
    emptyText:
      'Paste lyrics with chords from Ultimate Guitar or any site (Ctrl+V), or drop a .txt, .cho or .lrc file. Edit lyrics can also find them online or draft them from the vocals.',
    transcribing: (pct: number | null) =>
      `${pct === null ? 'Recognizing the words' : `Recognizing the words: ${pct}%`}. Then the lyrics follow the song.`,
    timeWhenHeard: 'The lyrics follow the song once the words are recognized. Or press ; at the start of each line.',
    tabNoVoice: 'A tab has no voice to recognize. Press ; at the start of each line to time the lyrics.',
    noStems: "Without stems the words can't be recognized. Press ; at the start of each line to time the lyrics.",
    shiftTip: (shift: string) => `The lyrics' chords are moved ${shift} to match the recording. Click to show them as written.`,
    shiftButton: (shift: string) => `chords ${shift}`,
  },

  lyricsEditor: {
    label: 'Edit lyrics',
    placeholder: 'Paste lyrics with chords above the lines, for example:\n\nAm        Dm\nWords of the first line\nE7              Am\nWords of the second line',
    draft: 'Draft from vocals',
    findOnline: 'Find lyrics online',
    saveLrc: 'Save .lrc',
    saveCho: 'Save .cho',
    remove: 'Remove lyrics',
    source: {
      paste: 'Lyrics pasted.',
      file: 'Lyrics from a file.',
      lrclib: 'Lyrics found online.',
      draft: 'Lyrics drafted from the vocals.',
    },
    needsVocals: 'Words are recognized from the vocal stem, and this song has none yet.',
    notHeard: 'Words not recognized yet.',
    queued: 'Word recognition is waiting in line.',
    running: (pct: number | null) => (pct === null ? 'Recognizing the words…' : `Recognizing the words: ${pct}%`),
    failed: (error: string) => `Words weren't recognized: ${error}`,
    heard: (language: string | null) =>
      `Words recognized${language ? ` (language: ${language})` : ''}. The lyrics follow the song by them.`,
    privacy: 'Find lyrics online sends only the artist, title and length to lrclib.net.',
  },

  tab: {
    failed: "The tab didn't load.",
    empty: 'Drop a Guitar Pro (.gp, .gp5, .gpx…) or MusicXML file here to add a tab to this song. Or paste a text tab (Ctrl+V).',
    part: 'Part',
    remove: 'Remove tab',
  },

  chart: {
    editChord: 'Edit chord',
    change: 'chord change',
    failed: (error: string) => `Bars and chords weren't found: ${error}`,
    finding: (pct: number | null) => (pct === null ? 'Finding bars and chords…' : `Finding bars and chords: ${pct}%`),
    afterStems: 'Bars and chords appear once the song is separated into stems.',
  },

  chordEditor: {
    label: 'Edit chord',
    split: 'Split at beat',
    merge: 'Merge with previous',
    noChord: 'No chord',
    restoreAll: 'Press again to restore all chords',
    root: 'Root',
    type: 'Chord type',
    major: 'major',
  },

  noteEditor: {
    label: 'Edit note',
    note: 'Note',
    down: '▼ Semitone down',
    up: '▲ Semitone up',
    remove: 'Remove note',
    restoreAll: 'Press again to restore all notes',
  },

  notes: {
    label: 'Guitar notes',
    editNote: 'Edit note',
    phraseOf: (n: number, of: number) => `phrase ${n} of ${of}`,
  },

  stage: {
    exit: 'Press Esc to exit',
  },

  printout: {
    capo: (n: number) => `Capo: fret ${n}`,
  },

  wave: 'Song waveform: click to jump, drag to make a loop',
};
