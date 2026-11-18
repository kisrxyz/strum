// «Запись» (\): records what the player hears — the guitar, and the song while one plays — and
// sends it to the song service in chunks of about a second. The service lines the two up by the
// moments each chunk carries and builds the mp3 (service/src/kv_service/takes.py). Beside them goes
// the card's dry input, frame for frame with the guitar: not heard, kept to check the input by.
import { useSettings } from '../state/settings';
import { L } from '../i18n';
import { messageText } from '../i18n/messages';
import { engine } from '../audio/engine';
import { api, type TakeTrack } from '../song/api';
import { fmtTime } from '../song/format';
import { songPlayer } from '../song/player';
import type { Take } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { refreshTakes, useTakes } from '../state/takes';
import { TrackChunker, fromFrame, isSilent } from './clock';
import type { BlockSink, TrackSource } from './tap';

/** About a second of sound per chunk (the exact size does not matter). */
const CHUNK_FRAMES = 48_000;
const MAX_SECONDS = 30 * 60;

/** The recorder's words, in the language of the moment they are shown. */
const text = () => L().actions.record;

interface Track {
  name: TakeTrack;
  source: TrackSource | null;
  chunker: TrackChunker;
  /** The source's frame of the track's first frame. */
  base: number | null;
  /** Where the source puts the track's blocks. */
  sink: BlockSink;
}

interface Session {
  id: string;
  tracks: Track[];
  /** The chunks go out one after another. */
  queue: Promise<void>;
  failed: boolean;
  stopping: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  unsubscribe: () => void;
}

let session: Session | null = null;
let starting = false;

const toast = (text: string, tone: 'info' | 'warn' = 'info') => useRuntime.getState().showToast(text, tone);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : text().failed);

function enqueue(s: Session, task: () => Promise<void>): void {
  s.queue = s.queue.then(async () => {
    if (s.failed) return;
    try {
      await task();
    } catch {
      s.failed = true;
      void stop(text().lost);
    }
  });
}

/**
 * A track and the sink that fills it. `follows`: the track whose first frame is this one's too. The
 * dry input runs on the guitar's clock and is numbered from the guitar's first frame, so the two
 * line up frame for frame; what it got before that frame is left out.
 */
function newTrack(s: Session, name: TakeTrack, follows?: Track): Track {
  const track: Track = {
    name,
    source: null,
    base: null,
    chunker: new TrackChunker(CHUNK_FRAMES, (chunk) => {
      const source = track.source;
      // Only the guitar sends its silence (a gap reads back as silence anyway): the band is silent
      // while no song plays, the dry input while there is no input at all.
      if (!source || track.base === null || (name !== 'guitar' && isSilent(chunk.data))) return;
      const moment = source.moment(track.base + chunk.at);
      if (moment === null || !Number.isFinite(moment)) return;
      enqueue(s, () => api.takeChunk(s.id, name, chunk.at, source.rate, moment, chunk.data));
    }),
    sink: (frame, left, right) => {
      if (s.stopping) return;
      let base = track.base;
      if (base === null) {
        base = follows ? follows.base : frame;
        if (base === null) return; // the guitar's first block has not come yet
        track.base = base;
      }
      const part = fromFrame(base, frame, left, right);
      if (part) track.chunker.push(part[0] - base, part[1], part[2]);
    },
  };
  return track;
}

/** Opens one track with a source of its own; false when that source cannot record now. */
async function addTrack(s: Session, name: TakeTrack, open: (sink: BlockSink) => Promise<TrackSource | null>): Promise<boolean> {
  const track = newTrack(s, name);
  try {
    track.source = await open(track.sink);
  } catch (error) {
    console.warn(`[record] ${name} did not start`, error);
    track.source = null;
  }
  if (!track.source) return false;
  s.tracks.push(track);
  return true;
}

/**
 * The guitar, and (when the settings keep it, for checking a sound card) the card's dry input on its
 * frames: one source, one clock. False when it cannot record now.
 */
async function addGuitar(s: Session): Promise<boolean> {
  const guitar = newTrack(s, 'guitar');
  const dry = useSettings.getState().saveRawInput ? newTrack(s, 'dry', guitar) : null;
  let source: TrackSource | null = null;
  try {
    source = await engine.recordGuitar(guitar.sink, dry?.sink);
  } catch (error) {
    console.warn('[record] guitar did not start', error);
  }
  if (!source) return false;
  guitar.source = source;
  s.tracks.push(guitar);
  if (dry) {
    dry.source = source;
    s.tracks.push(dry);
  }
  return true;
}

async function start(): Promise<void> {
  if (session || starting || useTakes.getState().saving) return;
  if (!engine.running) {
    toast(text().noGuitar, 'warn');
    return;
  }
  starting = true;
  try {
    const song = useSong.getState().song;
    let take: Take;
    try {
      take = await api.createTake({
        songId: song?.id ?? null,
        title: song?.title ?? text().noSong,
        artist: song?.artist ?? '',
        path: engine.guitarPath ?? 'browser',
      });
    } catch (error) {
      toast(messageOf(error), 'warn');
      return;
    }
    const s: Session = {
      id: take.id,
      tracks: [],
      queue: Promise.resolve(),
      failed: false,
      stopping: false,
      timer: undefined,
      unsubscribe: () => undefined,
    };
    session = s;
    if (!(await addGuitar(s))) {
      session = null;
      s.stopping = true;
      void api.deleteTake(s.id).catch(() => undefined);
      toast(text().noStart, 'warn');
      return;
    }
    // The song player's context exists once the engine has started: the band is there even if no
    // song plays yet (a song opened or started later is in the take too).
    await addTrack(s, 'band', (sink) => songPlayer.recordBand(sink));
    if (session !== s) return; // stopped while the band was being tapped
    const path = useRuntime.getState().guitarPath;
    s.unsubscribe = useRuntime.subscribe((state) => {
      if (state.guitarPath !== path || state.status !== 'running') void stop(text().pathChanged);
    });
    s.timer = setTimeout(() => void stop(text().limit(MAX_SECONDS / 60)), MAX_SECONDS * 1000);
    useTakes.getState().patch({ recording: { id: s.id, startedAt: performance.now() } });
  } finally {
    starting = false;
  }
}

/** Stops the recording and has the service build the take. `note`: why it stopped (not by hand). */
async function stop(note?: string): Promise<void> {
  const s = session;
  if (!s || s.stopping) return;
  s.stopping = true;
  session = null;
  clearTimeout(s.timer);
  s.unsubscribe();
  // The guitar and the dry input share one source: each source stops once.
  for (const source of new Set(s.tracks.map((t) => t.source))) source?.stop();
  for (const track of s.tracks) track.chunker.flush();
  useTakes.getState().patch({ recording: null, saving: true });
  await s.queue;
  try {
    if (s.failed) {
      toast(text().lost, 'warn');
      return;
    }
    const take = await api.finishTake(s.id);
    if (take.status === 'error') {
      toast(messageText(take.error) || text().notSaved, 'warn');
      return;
    }
    toast(note ?? text().saved(fmtTime(take.duration)), note ? 'warn' : 'info');
    await refreshTakes(take.id);
  } catch (error) {
    toast(messageOf(error), 'warn');
  } finally {
    useTakes.getState().patch({ saving: false });
  }
}

export const recorder = {
  /** \ and the top bar's button: start, or stop and save. */
  toggle(): void {
    if (starting) return; // a moment: the take is being opened
    if (session) void stop();
    else void start();
  },
};
