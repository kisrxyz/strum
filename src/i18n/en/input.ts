// Namespace `input`: the Input screen, the tuner, the level meter, latency, and the guitar path.
// See ../README.md for the copy rules and the glossary.
import { plural } from '../plural';

export const input = {
  title: 'Input',
  source: 'Source',
  guitarPath: 'Guitar path',
  asio: 'ASIO',
  systemAudio: 'System audio',
  soundCard: 'Sound card',
  automatic: 'Automatic',
  buffer: 'Buffer',
  device: 'Device',
  noInput: 'No input (song only)',
  defaultInput: 'Default input',
  channel: 'Channel',
  channelLabel: 'Input channel',
  channels: { auto: 'Auto', left: 'Left', right: 'Right', both: 'Both' },
  channelNow: (name: string) => `now: ${name}`,
  channelNames: { left: 'left', right: 'right', both: 'both' },
  level: 'Level',
  tuner: 'Tuner',
  a4: 'A4',
  lower: 'Lower',
  higher: 'Higher',
  lowerTip: '1 Hz lower',
  higherTip: '1 Hz higher',
  bigTuner: 'Big tuner',
  latency: 'Latency',
  latencyParts: (inMs: number, estimated: boolean, processingMs: number, outMs: number) =>
    `in ${inMs}${estimated ? ' (approx.)' : ''} + processing ${processingMs} + out ${outMs} ms`,
  latencyLater: 'Shown once the sound starts.',
  bufferWontHelp: 'A buffer change won’t help here. Replug the card’s USB.',
  latencyMode: 'Mode: if it clicks, pick Safe',
  latencyModeLabel: 'Latency mode',
  fast: 'Fast',
  safe: 'Safe',
  output: 'Output',
  sampleRate: (khz: string) =>
    `Sound runs at ${khz} kHz, but the amp models were captured at 48 kHz, so the tone may differ a little. In Windows: Settings → System → Sound → your device → Format: 48 000 Hz.`,

  // Latency and buffer (guitarInput.ts)
  latencyLine: (total: string, inMs: string, outMs: string) => `Latency ≈ ${total} ms (in ${inMs} + out ${outMs})`,
  advice: {
    great: 'Great: no audible latency.',
    ok: 'OK. If the sound lags, plug the headphones into the sound card and close other programs.',
    bad: 'Noticeable. Plug the headphones into the sound card and close other programs.',
  },
  nativeAdvice: {
    ok: 'OK. For less, pick a smaller buffer.',
    bad: 'Noticeable. Pick a smaller buffer.',
  },
  sourceNative: 'Reported by the sound card driver',
  sourceSystem: 'Estimated by the system',
  badgeNative: 'Latency from string to sound, reported by the sound card driver',
  badgeSystem: 'Latency from string to sound, estimated by the system',
  clicksBigger: (n: number) => `There were clicks (${n}). Try a bigger buffer.`,
  clicksClose: (n: number) => `There were clicks (${n}). Close other programs.`,
  micHint: 'If the browser asks about the microphone, allow it: that’s how it hears the guitar.',

  // Set input level (InputTrim.tsx)
  trim: 'Set input level',
  trimNow: 'Input level',
  trimNone: 'not set',
  trimAsk: 'Strum as hard as you can, like in the loudest part.',
  trimWaiting: 'Waiting for a strum…',
  trimHeard: (n: number) => `${n} ${plural(n, { one: 'strum', other: 'strums' })}`,
  trimOk: (db: string) => `Input level: ${db}`,
  trimClip: (db: string) => `The card itself overloads. Turn down Gain and try again (now ${db}).`,
  trimWeak: (max: string) => `Too quiet even at ${max}. Turn up Gain on the card and try again.`,
  trimSilent: 'No guitar heard. Check the cable and the channel, then try again.',

  // The level meter
  meter: 'Input level',
  zones: {
    silent: 'Silence. Strum the strings. If the bar stays still, check the cable and the device: a plain adapter into the headphone jack won’t work.',
    low: 'Quiet. Turn up Gain on the sound card or the volume on the guitar.',
    soft: 'A bit quiet for the amps. Press Set input level (G) or turn up Gain on the card.',
    good: 'Good level.',
    hot: 'Loud, but not clipping. You can turn Gain down a little.',
    clip: 'Input clipping. Turn down Gain on the sound card.',
  },

  // The tuner
  playNote: 'Play a note',
  stringName: (n: number) => `String ${n}`,

  // Devices (audio/input.ts)
  deviceN: (n: number) => `Device ${n}`,
  defaultDevice: 'Default: ',
  inputLost: 'Input lost. Check the cable or the adapter.',
  inputBack: 'Input is back.',
  deviceBusy: 'This device is busy in another program.',
  deviceFailed: 'This device could not be opened.',
  outputFailed: 'Could not switch the sound output.',

  // The guitar path (audio/native/session.ts)
  asioNotStarted: 'ASIO did not start. The guitar plays through system audio.',
  asioLost: 'ASIO stopped. The guitar plays through system audio.',
  asioBack: 'ASIO is back.',
  ownFileGone: 'Your amp file is missing. Drop it into the window again.',
  driverStuck: 'Latency jumped: the card’s driver holds about 10 ms extra. Unplug the card’s USB and plug it back in.',
  /** After the tuner's cents figure. */
  centsUnit: 'cents',
  saveRawInput: 'Save raw input in takes',
  saveRawInputHint: 'Each take also keeps the card’s input before the amp (dry.flac), for checking noise, hum and level. Takes get about twice as big.',
};
