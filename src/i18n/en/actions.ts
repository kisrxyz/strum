// Namespace `actions`: what the keys and buttons say when they act (toasts, errors), and the
// display names the logic hands out (lists, tunings, unnamed tab parts). See ../README.md for the
// copy rules and the glossary.
import { plural } from '../plural';

/** A signed figure: +12, −12 (minus sign), 0. */
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const minutes = (n: number) => `${n} ${plural(n, { one: 'minute', other: 'minutes' })}`;

export const actions = {
  song: {
    /** The song's own settings (speed, loop, chords…) did not reach the disk. */
    settingsNotSaved: (reason: string) => `The song's settings were not saved. ${reason}`.trim(),
    openFirst: 'Open a song first.',
    loading: 'Loading the song…',
    notLoaded: 'The song did not load. Open it again from Songs.',
    /** The song player could not load the song; `reason` is a sentence. */
    loadFailed: (reason: string) => `The song did not load. ${reason}`,
    openFailed: 'The song did not open.',
    /** A tab-song whose tab file is gone. */
    tabMissing: 'The tab file is missing.',
    /** “Title” by Artist: a song named in a toast. */
    title: (title: string, artist: string) => (artist ? `“${title}” by ${artist}` : `“${title}”`),
    deleteAgain: (title: string) => `Press again to delete “${title}” with its stems.`,
    deleted: (title: string) => `“${title}” deleted.`,
    deleteFailed: 'Could not delete the song.',
    /** The song's own drift from the guitar's tuning, made up for by the song's pitch. */
    tuned: (drift: number, cents: number) => `The recording is ${signed(drift)} cents off. Song tuned by ${signed(cents)} cents.`,
  },
  analysis: {
    failed: "Bars were not found. Details are on the song's card.",
    running: 'Still finding bars and chords.',
    again: 'Finding bars and chords again. Your edits stay.',
    startFailed: 'Could not start finding bars.',
    noSections: 'No sections found.',
    barsLater: 'Bar lines one beat later',
    barsEarlier: 'Bar lines one beat earlier',
  },
  loop: {
    /** A loop from A to B: “1:02–1:10”. */
    set: (range: string) => `Loop ${range}`,
    start: (time: string) => `Loop start: ${time}`,
    needStart: 'Set the loop start first.',
    none: 'No loop yet. Drag across the waveform to set one.',
    needLoop: 'Set a loop first.',
    section: (name: string) => `Loop: ${name}`,
    phrase: (n: number, total: number, range: string) => `Loop: phrase ${n} of ${total} (${range})`,
    phraseAt: (n: number, total: number) => `Phrase ${n} of ${total}`,
  },
  bookmark: {
    /** The name a new bookmark gets. */
    name: (n: number) => `Bookmark ${n}`,
    added: (name: string, range: string) => `${name}: ${range}`,
    none: 'No bookmarks yet.',
  },
  mix: {
    guitarOff: 'Original guitar off',
    guitarOn: 'Original guitar on',
    guitarOnly: 'Guitar only',
    fullBand: 'Full band',
    tabSongStems: "In a tab song, the stems are the tab's parts.",
    noOtherStems: 'No other stems yet.',
    /** The stem model switch: the one place a model is named. */
    model: (name: string) => `Stems: ${name}`,
    separating: 'Separating into stems. You can play meanwhile.',
    separateFailed: 'Could not start separating.',
    dropFailed: 'Could not delete the stems.',
    stemsNeeded: 'This needs stems. Separate the song into stems first.',
  },
  ear: {
    on: 'Play by ear: chords hidden',
    off: 'Chords shown',
    onlyInEar: 'Hints are for playing by ear.',
    /** What each hint level shows. */
    hints: {
      0: 'Chords hidden',
      1: 'Hint 1: chord changes',
      2: 'Hint 2: the current chord',
      3: 'Hint 3: all chords',
    },
  },
  practice: {
    clickOn: 'Click on',
    clickOff: 'Click off',
    countInOn: 'Count-in on',
    countInOff: 'Count-in off',
    simpleOn: 'Simple chords: major and minor only',
    simpleOff: 'Full chords',
    capo: (fret: number) => `Capo on fret ${fret}`,
    noCapo: 'No capo',
    tuning: (name: string) => `Tuning: ${name}`,
    toneOff: 'Match song tone off',
    toneOn: 'Match song tone on',
    toneWaiting: "Match song tone turns on once the song's guitar is found.",
    repeatOn: 'Repeat after me: one pass listen, one pass play',
    repeatOff: 'Repeat after me off',
    trainerOn: (from: string, step: string) => `Speed trainer: from ${from}, ${step} each pass`,
    trainerOff: 'Speed trainer off',
    trainerDone: (full: string) => `Speed trainer reached ${full}.`,
  },
  export: {
    /** The backing track's file name when the download names none (without .mp3). */
    fileName: 'Backing track',
    tabSong: "Backing tracks can't be made from tab songs yet. Record one without the guitar instead.",
    stemsNotReady: 'The stems are not ready yet.',
    making: 'Making the backing track…',
    saved: (fileName: string) => `Backing track saved to Downloads: “${fileName}”`,
    failed: 'The backing track failed.',
  },
  notes: {
    tabPart: 'This part has no notes to show. Pick another part.',
    needStems: 'Notes come from the guitar stem. Separate the song into stems first.',
    filesMissing: 'Notes need program files that are missing. Reinstall Strum.',
    running: 'Still finding the notes.',
    failed: "Notes were not found. Details are on the song's card.",
    none: 'No single notes heard in the guitar stem.',
    note: (name: string) => `Note: ${name}`,
    reset: 'Note edits undone.',
  },
  lyrics: {
    none: 'No lyrics yet. Paste them or drop a file.',
    allMarked: 'All lines are marked.',
    lineFrom: (text: string, time: string) => `“${text}” starts at ${time}.`,
    instrumentalFrom: (time: string) => `Instrumental starts at ${time}.`,
    noMark: 'This line has no mark.',
    markRemoved: 'Line mark removed.',
    replaced: 'Lyrics replaced.',
    pasted: 'Lyrics pasted.',
    fromFile: (fileName: string) => `Lyrics added from “${fileName}”.`,
    tabSongNoVoice: 'A tab song has no voice to hear words from. Paste the lyrics or search online.',
    draft: 'Draft from the vocals. Check the words in the editor.',
    noWords: 'No words heard in the vocal stem.',
    transcribing: 'Still transcribing the vocals. The draft will appear by itself.',
    transcribeStarted: 'Transcribing the vocals…',
    transcribeAgain: 'Transcribing the vocals again…',
    transcribeFailed: 'Could not start transcribing.',
    wordsDownload: 'Downloading the words model (2.9 GB). Press again when it is done.',
    wordsDownloading: 'The words model is still downloading.',
    searching: 'Searching lyrics online…',
    searchOffline: 'The lyrics search did not answer. Check the internet connection.',
    notFound: (title: string) => `No lyrics found for “${title}” of the same length. Check the title and the artist.`,
    foundTimed: 'Lyrics found, with line times.',
    foundPlain: 'Lyrics found, without times. They will follow the vocals.',
    removeAgain: 'Press again to remove the lyrics.',
    removed: 'Lyrics removed.',
    noTimes: 'The lyrics have no line times yet, so there is no .lrc to save.',
    /** A saved file's name when the song has no title. */
    untitled: 'Song',
  },
  tab: {
    none: 'No tab yet.',
    noneHint: 'No tab yet. Drop a Guitar Pro or MusicXML file, or paste a text tab.',
    added: (fileName: string) => `Tab “${fileName}” added.`,
    saveFailed: 'The tab was not saved.',
    /** The file name of a tab pasted as text (without the extension). */
    pastedName: 'Pasted tab',
    later: 'Tab one bar later',
    earlier: 'Tab one bar earlier',
    tabSongSync: 'In a tab song, the tab is the song: the bars always match.',
    tabSongRemove: 'This is a tab song. Delete it in Songs.',
    onePart: 'This tab has one track.',
    part: (name: string) => `Track: ${name}`,
    /** A tab-song's part on screen is the one the player treats as the guitar. */
    yourPart: (name: string) => `Your part: ${name}`,
    /** A part without a name in the file. */
    track: (n: number) => `Track ${n}`,
    removeAgain: 'Press again to remove the tab.',
    removed: 'Tab removed.',
    removeFailed: 'Could not remove the tab.',
    /** alphaTab's own words (English) in brackets, when it gives any. */
    readFailed: (detail: string) => `Could not read the tab${detail ? ` (${detail})` : ''}.`,
    tooLong: (max: number) => `Tabs longer than ${minutes(max)} are not supported yet.`,
    addedSong: (title: string) => `“${title}” added as a tab song.`,
    /** What the tab worker reports (render.ts `TabErrorCode`). */
    errors: {
      unreadable: 'Could not read the tab. It is not a Guitar Pro or MusicXML file, or it is damaged.',
      empty: 'The tab is empty: there is nothing to play.',
      soundsMissing: 'Some program files are missing. Reinstall Strum.',
      failed: 'The tab could not be played.',
    },
  },
  add: {
    unreadable: 'Could not read the file. Songs can be mp3, m4a, wav or flac.',
    tooLong: (max: number) => `Songs longer than ${minutes(max)} are not supported yet.`,
    added: (title: string) => `“${title}” added. Separating into stems.`,
    exists: (title: string) => `“${title}” is already in Songs.`,
  },
  lists: {
    /** The lists of the Songs screen. */
    names: {
      all: 'All',
      favorite: 'Favorites',
      learn: 'Learning',
      set: 'Set list',
      takes: 'Takes',
    },
    notSaved: 'The list was not saved.',
    favoriteAdded: (song: string) => `${song} added to Favorites.`,
    favoriteRemoved: (song: string) => `${song} removed from Favorites.`,
    learnAdded: (song: string) => `${song} added to Learning.`,
    learnRemoved: (song: string) => `${song} removed from Learning.`,
    setAdded: (song: string, place: number) => `${song} added to the set list (#${place}).`,
    setRemoved: (song: string) => `${song} removed from the set list.`,
    orderOnlyInSet: 'The order can be changed in the set list only.',
    setEmpty: 'The set list is empty.',
    setPlaying: (n: number, total: number) => `Set list: ${n} of ${total}`,
    setDone: 'Set list finished.',
    setStopped: 'Set list stopped.',
    listEmpty: 'No songs in this list.',
    radio: 'Radio: shuffled, on repeat',
    radioOff: 'Radio off',
    nothingQueued: 'No set list or radio is playing.',
    next: (song: string) => `Next: ${song}`,
    random: (song: string) => `Random: ${song}`,
    noSongs: 'No songs yet. Drop a file into the window.',
  },
  record: {
    noGuitar: 'No guitar sound yet. Recording did not start.',
    noStart: 'Could not start recording the guitar.',
    pathChanged: 'Recording stopped: the guitar path changed. What was recorded is being saved.',
    limit: (max: number) => `Recording stopped after ${minutes(max)} and is being saved.`,
    lost: 'Recording stopped: songs are unavailable. What was sent will be saved after a restart.',
    failed: 'Recording failed.',
    notSaved: 'The take was not saved.',
    saved: (length: string) => `Take saved (${length}). Find it in Songs → Takes.`,
    /** The title of a take recorded with no song open. */
    noSong: 'No song',
    nudgeFailed: 'Could not move the guitar.',
    deleteAgain: (title: string, when: string) => `Press again to delete the take “${title}” from ${when}.`,
    deleted: 'Take deleted.',
    deleteFailed: 'Could not delete the take.',
  },
  /** The guitar tunings (music/tunings.ts). */
  tunings: {
    standard: 'Standard',
    eb: 'E♭ (half step down)',
    dropd: 'Drop D',
  },
};
