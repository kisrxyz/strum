// A tab rendered by alphaTab's synthesizer into the song player's six stems (12 channels): one
// pass per stem over the score's MIDI with every other channel's notes taken out, so a pass costs
// only its own parts. The soundfont is parsed once per render and shared by the passes: its
// compressed samples are decoded once (measured in Node with FluidR3, 2026-11-16: a 3.6-min song in
// 1.9 s instead of 2.5–3.9, a 7-min one in 2.3–2.6 s instead of 4.1; the sound bit for bit the
// same). Runs in the tab-song worker; core-only alphaTab import (see load.ts).
import { midi, synth, type model } from '@coderline/alphatab/core';
import { STEMS } from '../song/types';
import { scoreMidi, type StemPlan } from './tabSong';

const NOTE_EVENTS: ReadonlySet<number> = new Set([
  midi.MidiEventType.NoteOn,
  midi.MidiEventType.NoteOff,
  midi.MidiEventType.PerNotePitchBend,
]);
/** Milliseconds per exporter call. */
const CHUNK_MS = 2000;

/**
 * What can go wrong with a tab in the worker, as a code: the worker cannot read the language, so
 * the main thread puts the words to it (`actions.tab.errors`, tabSource.ts).
 */
export type TabErrorCode = 'unreadable' | 'empty' | 'soundsMissing' | 'failed';

/** A failure the user is told about. Its message is the code (English, for logs). */
export class TabError extends Error {
  readonly code: TabErrorCode;

  constructor(code: TabErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Takes the note events of every channel but `keep` out of the MIDI (in place). */
export function keepChannels(midiFile: midi.MidiFile, keep: ReadonlySet<number>): void {
  const lists = midiFile.tracks.length ? midiFile.tracks.map((t) => t.events) : [midiFile.events];
  for (const list of lists) {
    let kept = 0;
    for (const event of list) {
      const channel = (event as { channel?: number }).channel;
      if (NOTE_EVENTS.has(event.type) && channel !== undefined && !keep.has(channel)) continue;
      list[kept++] = event;
    }
    list.length = kept;
  }
}

/** The exporter needs an AlphaSynth, and an AlphaSynth needs an output: one that plays nothing. */
function silentOutput(sampleRate: number): synth.ISynthOutput {
  const event = () => ({ on() {}, off() {} });
  const nothing = () => undefined;
  return {
    sampleRate,
    ready: event(),
    sampleRequest: event(),
    samplesPlayed: event(),
    open: nothing,
    play: nothing,
    pause: nothing,
    addSamples: nothing,
    resetSamples: nothing,
    activate: nothing,
    destroy: nothing,
  } as unknown as synth.ISynthOutput;
}

/** A synthesizer holding the soundfont, parsed once: the exporters it makes share its decoded samples. */
function soundFontHost(soundFont: Uint8Array, sampleRate: number): synth.AlphaSynth {
  const host = new synth.AlphaSynth(silentOutput(sampleRate), 500);
  let failed: Error | null = null;
  host.soundFontLoadFailed.on((error) => (failed = error));
  host.loadSoundFont(soundFont, false);
  if (failed) throw new TabError('soundsMissing');
  return host;
}

function exporterFor(host: synth.AlphaSynth, made: ReturnType<typeof scoreMidi>, sampleRate: number) {
  const options = new synth.AudioExportOptions();
  options.sampleRate = sampleRate;
  // No `soundFonts`: the host's, parsed already.
  options.useSyncPoints = false;
  options.masterVolume = 1;
  options.metronomeVolume = 0;
  return host.exportAudio(options, made.midiFile, [], made.generator.transpositionPitches);
}

/**
 * Copies interleaved stereo into `left` / `right` from `at`. A NaN (the synthesizer's filter goes
 * unstable below 44.1 kHz) becomes silence: one NaN would silence the player's stretch for good.
 */
function copyChunk(samples: Float32Array, left: Float32Array, right: Float32Array, at: number): number {
  const n = Math.min(samples.length >> 1, left.length - at);
  for (let k = 0; k < n; k++) {
    const l = samples[2 * k];
    const r = samples[2 * k + 1];
    left[at + k] = l === l ? l : 0;
    right[at + k] = r === r ? r : 0;
  }
  return n;
}

/** Plays the exporter to its end into `left` / `right` (cut at their length); frames written. */
function play(exporter: synth.IAlphaSynthAudioExporter, left: Float32Array, right: Float32Array): number {
  let at = 0;
  while (at < left.length) {
    const chunk = exporter.render(CHUNK_MS);
    if (!chunk) break;
    at += copyChunk(chunk.samples, left, right, at);
  }
  return at;
}

/**
 * The six stems in the player's order (`STEMS`), left and right each: 12 arrays of `frames`.
 * A stem without parts stays silent.
 */
export function renderStems(score: model.Score, plan: StemPlan, sampleRate: number, frames: number, soundFont: Uint8Array): Float32Array[] {
  const host = soundFontHost(soundFont, sampleRate);
  const channels: Float32Array[] = [];
  for (const stem of STEMS) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    channels.push(left, right);
    if (!plan[stem].length) continue;
    const made = scoreMidi(score);
    keepChannels(made.midiFile, new Set(plan[stem]));
    play(exporterFor(host, made, sampleRate), left, right);
  }
  return channels;
}

/** Every part at once, as long as the synthesizer plays (for the length and the loudness). */
export function renderMix(score: model.Score, sampleRate: number, soundFont: Uint8Array): { left: Float32Array; right: Float32Array } {
  const made = scoreMidi(score);
  const exporter = exporterFor(soundFontHost(soundFont, sampleRate), made, sampleRate);
  const first = exporter.render(CHUNK_MS);
  const frames = first ? Math.ceil((first.endTime / 1000) * sampleRate) + (first.samples.length >> 1) : 0;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  if (!first) return { left, right };
  const n = copyChunk(first.samples, left, right, 0);
  const rest = play(exporter, left.subarray(n), right.subarray(n));
  return { left: left.subarray(0, n + rest), right: right.subarray(0, n + rest) };
}
