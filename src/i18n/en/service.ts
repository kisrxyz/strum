// Namespace `service`: words for the codes the song service and the guitar engine send
// (src/i18n/messages.ts). Keys are the codes themselves, `area.what`. Each entry takes the
// message's params object. See ../README.md for the copy rules.
type P = Record<string, string | number>;

/** A limit sent in seconds: "12 min", "45 s". */
const span = (seconds: string | number | undefined): string => {
  const s = Number(seconds) || 0;
  return s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;
};

const khz = (hz: string | number | undefined): string => `${(Number(hz) || 0) / 1000} kHz`;

export const service = {
  unknown: (code: string) => `Something went wrong (${code}).`,
  offline: 'Songs are unavailable. Restart Strum.',
  requestFailed: (p: P) => `Songs could not do that (error ${p.status}).`,

  'program.filesMissing': 'Some program files are missing. Reinstall Strum.',
  'origin.forbidden': 'Only Strum can use this address.',

  // Songs
  'song.notFound': 'Song not found.',
  'song.tooLong': (p: P) => `This song is longer than ${span(p.limit)}. Longer songs are not supported yet.`,
  'audio.wrongRate': (p: P) => `The song's audio must be ${khz(p.want)}, not ${khz(p.rate)}.`,
  'audio.notStereo': (p: P) => `The song's audio must be stereo (2 channels), not ${p.channels}.`,
  'audio.notFloat': "The song's audio arrived in the wrong format.",
  'audio.unreadable': "Couldn't read the song's audio.",

  // Stems, bars and chords, words
  'stems.notReady': 'These stems are not ready yet.',
  'stems.missing': "These stems don't exist.",
  'separation.failed': (p: P) => `Couldn't separate the song (${p.reason}).`,
  'separation.cpuNoGpu': 'No NVIDIA graphics card found, so separation ran on the processor (slower).',
  'separation.smallerChunks': 'The graphics card ran short of memory, so the song was separated in smaller pieces.',
  'separation.cpuNoVram': 'The graphics card ran short of memory, so separation ran on the processor (slower).',
  'separation.cpuGpuFailed': 'Separation failed on the graphics card, so it ran on the processor (slower).',
  'analysis.none': 'No bars or chords yet.',
  'analysis.failed': (p: P) => `Couldn't find the bars and chords (${p.reason}).`,
  'analysis.noMusic': 'No beats or chords found. This may not be music.',
  'analysis.crashedTwice': "Finding bars and chords stopped twice on this song. Start it again from the song's card.",
  'words.none': 'No words yet.',
  'words.failed': (p: P) => `Couldn't hear the words (${p.reason}).`,
  'words.crashedTwice': 'Hearing the words stopped twice on this song. Start it again from the lyrics editor.',
  'transcript.needsStems': 'Separate the song into stems first.',

  // Tabs and tab songs
  'tab.none': 'This song has no tab.',
  'tab.notATab': 'This is not a tab file.',
  'tab.empty': 'The tab file is empty.',
  'tab.tooBig': (p: P) => `The tab file is over ${p.limit} MB. Is it really a tab?`,
  'tab.tooLong': (p: P) => `This tab is longer than ${span(p.limit)}. Longer songs are not supported yet.`,
  'tab.keyUnreadable': "Couldn't read the tab's key.",
  'tabSong.nothingToSeparate': 'A song made from a tab has no recording to separate or listen to.',
  'tabSong.noExport': "A backing track can't be made from a tab song yet.",
  'tabSong.noAudio': 'A tab song has no audio file. Strum plays it from the tab.',
  'tabSong.tabIsTheSong': 'This song is a tab. Another tab becomes a new song.',

  // Backing track
  'export.stemsNotReady': 'The stems are not ready yet. The backing track is available once the song is separated.',
  'export.tooShort': 'Too short for a backing track.',

  // Takes
  'take.none': 'Take not found.',
  'take.chunkTooBig': 'A piece of the take is too big.',
  'take.chunkBroken': 'A piece of the take arrived broken.',
  'take.tooShort': 'The take was shorter than a second and was not saved.',
  'take.tooLong': (p: P) => `A take can be up to ${span(p.limit)} long.`,
  'take.notRecording': 'This take has already finished.',
  'take.rateChanged': 'The sample rate changed in the middle of the take.',
  'take.broken': (p: P) => `The take was not saved (${p.reason}).`,

  // The guitar engine (ASIO)
  'guitar.rate':
    "The sound card did not open at 48 000 Hz. Set it to 48 000 Hz in the card's control panel and in Windows sound settings.",
  'guitar.deviceLost': 'The sound card is gone. Check the USB cable.',
  'guitar.noDevices': 'No sound card found. Connect the card and check that its ASIO driver is installed.',
  'guitar.deviceNotFound': (p: P) => `Sound card “${p.name}” not found. Check that it is connected, or pick another one.`,
  'guitar.openFailed': (p: P) =>
    `The sound card did not open (${p.reason}). Close programs that may be using it and try again.`,
  'guitar.chainBroke': (p: P) => `The ASIO guitar sound failed (${p.reason}).`,
  'guitar.processDied': 'The ASIO guitar sound stopped. It restarts by itself in a few seconds.',
  'guitar.processFailed': (p: P) => `The ASIO guitar sound did not start (${p.reason}).`,

  // Amp, cabinet and reverb files
  'amp.modelFailed': (p: P) => `The amp model did not load (${p.reason}). The simple amp plays instead.`,
  'amp.engineFailed': (p: P) => `The amp did not start (${p.reason}). The simple amp plays instead.`,
  'amp.cabFailed': (p: P) => `The cabinet did not load (${p.reason}).`,
  'amp.reverbFailed': (p: P) => `The reverb did not load (${p.reason}).`,
  'amp.userModelGone': 'Your amp model is missing. Drop the .nam file again.',
  'amp.userIrGone': 'Your cabinet is missing. Drop the .wav file again.',
  'amp.unknownBuiltIn': (p: P) => `Unknown built-in sound: ${p.id}.`,
  'amp.irUnreadable': "Couldn't read the cabinet. It needs a WAV file.",
  'amp.irSilent': 'This WAV file has no sound.',

  // Settings and your own amp files, kept beside the songs
  'settings.none': 'No settings saved yet.',
  'settings.tooBig': 'The settings are too big to save.',
  'settings.bad': 'The settings could not be read.',
  'asset.none': 'This amp file is missing.',
  'asset.bad': 'This amp file could not be saved.',
  'asset.tooBig': 'This file is too big for an amp or a cabinet.',

  // Downloading the song separation and the words of the vocals (installed app)
  'components.failed': (p: P) => `The download stopped (${p.reason}).`,
};
