// The tab-song worker: reads a tab, renders it with alphaTab's synthesizer and makes the song's
// analysis from the score, off the main thread (about a second for a whole song). It imports
// alphaTab's core only: the package's main module would take this worker's messages over.
import { STEMS, type Analysis } from '../song/types';
import { readScore } from './load';
import { renderMix, renderStems, TabError, type TabErrorCode } from './render';
import { isSoundFont, loudnessDb, mixPeaks, stemsLoudnessDb } from './tabAudio';
import { scoreMidi, stemPlan, tabAnalysis, tabSongFacts, type TabSongFacts } from './tabSong';

/** What a new tab-song is created with. */
export interface TabSongInfo extends TabSongFacts {
  /** Seconds the song plays. */
  duration: number;
  /** The whole render's loudness (the service's formula). */
  loudnessDb: number;
  /** For the song list (the analysis itself is made again whenever the song opens). */
  key: Analysis['key'];
}

/** A tab-song ready for the player. */
export interface TabRender {
  /** The six stems in the player's order, left and right each, at the asked rate and length. */
  channels: Float32Array[];
  /**
   * The loudness of this render, all stems together (the service's formula): the song is levelled
   * by it, not by the number stored when the song was made — that one may come from other sounds.
   */
  loudnessDb: number;
  /** Waveform of all the stems together (100 min/max pairs per second). */
  peaks: Int8Array;
  analysis: Analysis;
  /** The parts' names; '' for a part without one (tabSource.ts names it in the current language). */
  trackNames: string[];
}

export type TabWorkerRequest =
  | { id: number; cmd: 'inspect'; bytes: Uint8Array; ext: string }
  | { id: number; cmd: 'render'; bytes: Uint8Array; ext: string; track: number; sampleRate: number; duration: number };

/** A failure is a code (the worker has no language); `detail` is the original error, for the console. */
export type TabWorkerReply =
  | { id: number; info: TabSongInfo }
  | { id: number; render: TabRender }
  | { id: number; error: TabErrorCode; detail?: string };

/**
 * The sounds, the first one there: FluidR3 (`npm run setup` puts it in public/tones/, 24 MB, samples
 * at 44.1 kHz), else alphaTab's small Sonivox (1.4 MB, samples at 11–22 kHz), copied to public/ by
 * its Vite plugin.
 */
const SOUNDFONT_URLS = ['/tones/soundfont/fluidr3-mono.sf3', '/soundfont/sonivox.sf2'];
/** The rate the length and loudness of a new tab-song are measured at. */
const MEASURE_RATE = 44100;

/** The worker's global scope (the DOM typings the project uses describe a window, not a worker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<TabWorkerRequest>) => void) | null;
  postMessage(message: TabWorkerReply, transfer: Transferable[]): void;
  location: { origin: string };
}
const scope = self as unknown as WorkerScope;

let soundFont: Promise<Uint8Array> | null = null;

/** Fetched once. The dev server answers a missing file with the app's page: check the contents. */
function loadSoundFont(): Promise<Uint8Array> {
  soundFont ??= (async () => {
    for (const url of SOUNDFONT_URLS) {
      try {
        const response = await fetch(new URL(url, scope.location.origin));
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (response.ok && isSoundFont(bytes)) return bytes;
      } catch {
        /* the next one */
      }
    }
    throw new TabError('soundsMissing');
  })();
  soundFont.catch(() => {
    soundFont = null;
  });
  return soundFont;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

const post = (reply: TabWorkerReply, transfer: Transferable[] = []) => scope.postMessage(reply, transfer);

scope.onmessage = async (event: MessageEvent<TabWorkerRequest>) => {
  const request = event.data;
  const { id } = request;
  try {
    let score;
    try {
      score = readScore(request.bytes, request.ext);
    } catch {
      throw new TabError('unreadable');
    }
    const font = await loadSoundFont();
    const made = scoreMidi(score);
    const facts = tabSongFacts(score, made);
    if (request.cmd === 'inspect') {
      const mix = renderMix(score, MEASURE_RATE, font);
      const duration = Math.max(facts.end, mix.left.length / MEASURE_RATE);
      if (!(duration > 0.5)) throw new TabError('empty');
      const loudness = round(loudnessDb(mix.left, mix.right, MEASURE_RATE), 2);
      const { key } = tabAnalysis(score, facts.track, made);
      post({ id, info: { ...facts, duration: round(duration, 3), loudnessDb: loudness, key } });
      return;
    }
    const track = Math.min(Math.max(0, request.track), score.tracks.length - 1);
    const frames = Math.max(1, Math.round(request.duration * request.sampleRate));
    const plan = stemPlan(score, track);
    const channels = renderStems(score, plan, request.sampleRate, frames, font);
    // The waveform of the stems that play (the silent ones add nothing).
    const playing = STEMS.flatMap((stem, i) => (plan[stem].length ? [channels[2 * i], channels[2 * i + 1]] : []));
    const peaks = playing.length ? mixPeaks(playing, request.sampleRate) : mixPeaks([channels[0], channels[1]], request.sampleRate);
    const loudness = round(stemsLoudnessDb(playing.length ? playing : [channels[0], channels[1]], request.sampleRate), 2);
    const render: TabRender = { channels, loudnessDb: loudness, peaks, analysis: tabAnalysis(score, track, made), trackNames: facts.trackNames };
    post({ id, render }, [...channels.map((c) => c.buffer), peaks.buffer]);
  } catch (error) {
    if (error instanceof TabError) post({ id, error: error.code });
    else post({ id, error: 'failed', detail: error instanceof Error ? error.message : String(error) });
  }
};
