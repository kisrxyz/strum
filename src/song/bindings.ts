// The open song drives the player, the way src/audio/bindings.ts drives the engine: the UI only
// changes useSong / useSettings, never the player directly.
import { L } from '../i18n';
import { useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { currentPreset, useSettings } from '../state/settings';
import { api } from './api';
import { beatGrid, centsToMatch } from './grid';
import { songBusDb, stemGains } from './mix';
import { songPlayer, type PlayerSource } from './player';
import { needsReload } from './reload';
import { isTabSong, STEMS, type Analysis, type ModelId, type PlayerSettings, type Song, type Stem } from './types';
import { renderTab } from '../tab/tabSource';

/**
 * What the player should have loaded: a model's ready stems, or the whole mix meanwhile. A
 * tab-song plays its own render, made again for another part on screen (it is the «guitar»).
 */
export function wantedSource(song: Song): { key: string; source: 'mix' | ModelId | 'tab' } {
  if (isTabSong(song)) return { key: `tab:${song.tab?.track ?? 0}@${song.tab?.addedAt ?? ''}`, source: 'tab' };
  const model = song.activeModel;
  const info = model ? song.stems[model] : undefined;
  if (model && info?.status === 'ready') return { key: `${model}@${info.finishedAt ?? ''}`, source: model };
  return { key: 'mix', source: 'mix' };
}

function playerSource(song: Song, source: 'mix' | ModelId): PlayerSource {
  if (source === 'mix') return { kind: 'mix', url: api.mixUrl(song.id) };
  const version = song.stems[source]?.finishedAt ?? '';
  const urls = Object.fromEntries(STEMS.map((stem) => [stem, api.stemUrl(song.id, source, stem, version)]));
  return { kind: 'stems', urls: urls as Record<Stem, string> };
}

/** A load that a newer one replaced (another part, another song): its result is dropped. */
class Overtaken extends Error {}

/**
 * A tab-song: the tab rendered for the player's context (the part on screen as the «guitar»),
 * with its analysis and waveform made from the score. `current()` is false once a newer load began.
 */
async function tabSongSource(song: Song, current: () => boolean): Promise<PlayerSource> {
  const tab = song.tab;
  const rate = songPlayer.sampleRate;
  if (!tab || !rate) throw new Error(L().actions.song.tabMissing);
  const bytes = await api.tab(song.id, tab.addedAt);
  const render = await renderTab(bytes, tab.ext, tab.track, rate, song.duration);
  if (!current()) throw new Overtaken();
  tabLoudness = { id: song.id, db: render.loudnessDb };
  useSong.getState().patch({ analysis: render.analysis, peaks: render.peaks, parts: render.trackNames });
  return { kind: 'pcm', channels: render.channels };
}

/**
 * The loudness of the open tab-song as rendered now. The one in song.json was measured when the
 * song was made, maybe with other sounds (until 2026-11-16 alphaTab's small set): levelled by it,
 * the song would come out louder or quieter than the others.
 */
let tabLoudness: { id: string; db: number } | null = null;

function busDb(song: Song, source: 'mix' | ModelId | 'tab' | null): number {
  const stemsGainDb = source && source !== 'mix' && source !== 'tab' ? (song.stems[source]?.gainDb ?? 0) : 0;
  const loudness = source === 'tab' && tabLoudness?.id === song.id ? tabLoudness.db : song.loudnessDb;
  return songBusDb(loudness, stemsGainDb, useSettings.getState().songVolumeDb);
}

function applySettings(song: Song): void {
  const p = song.player;
  songPlayer.setRate(p.speed);
  songPlayer.setPitch(p.semitones + p.cents / 100);
  songPlayer.setLoop(p.loop);
  songPlayer.setGains(stemGains(p));
  songPlayer.setBusDb(busDb(song, useSong.getState().source));
  songPlayer.setGrid(beatGrid(song, useSong.getState().analysis));
  songPlayer.setClick(p.click);
  songPlayer.setCountIn(p.countIn);
}

let analysisKey: string | null = null;
let wordsKey: string | null = null;

/** Fetches the heard words when they become ready or are heard again (like the analysis). */
async function loadWords(song: Song): Promise<void> {
  const info = song.transcript;
  if (!info?.finishedAt) return;
  const key = `${song.id}@${info.finishedAt}`;
  if (key === wordsKey) return;
  wordsKey = key;
  try {
    const words = await api.words(song.id, info.finishedAt);
    if (wordsKey !== key || useSong.getState().song?.id !== song.id) return;
    useSong.getState().patch({ words });
  } catch (error) {
    wordsKey = null;
    console.warn('[song] words did not load', error);
  }
}

/**
 * Fetches the analysis when it becomes ready or is made again. While a new one is being made the
 * old one stays on screen; another song starts without one (openSong clears it).
 */
async function loadAnalysis(song: Song): Promise<void> {
  const info = song.analysis;
  // finishedAt stays while a new analysis runs or after one fails: the last good one is still served.
  if (!info?.finishedAt) return;
  const key = `${song.id}@${info.finishedAt}`;
  if (key === analysisKey) return;
  analysisKey = key;
  try {
    const analysis = await api.analysis(song.id, info.finishedAt);
    if (analysisKey !== key || useSong.getState().song?.id !== song.id) return;
    useSong.getState().patch({ analysis });
  } catch (error) {
    analysisKey = null;
    console.warn('[song] analysis did not load', error);
  }
}

const AUTO_CENTS_MIN = 10;

/** «Автоподстройка в центах»: once per song, the recording's drift becomes the song's cents. */
function applyTuningOnce(song: Song, analysis: Analysis): void {
  const p = song.player;
  if (p.tuningApplied) return;
  const patch: Partial<PlayerSettings> = { tuningApplied: true };
  const cents = centsToMatch(analysis.tuningCents, useSettings.getState().a4);
  // The estimate is good to about ±10 cents on real recordings: smaller drifts are left alone, so
  // a song recorded at 440 Hz is not pushed off it.
  if (p.cents === 0 && Math.abs(cents) >= AUTO_CENTS_MIN) {
    patch.cents = cents;
    const drift = Math.round(analysis.tuningCents);
    useRuntime.getState().showToast(L().actions.song.tuned(drift, cents));
  }
  useSong.getState().updatePlayer(patch);
}

let loadedKey: string | null = null;
let failedKey: string | null = null;
/** True while a swapped-in tab-song render resumes: no count-in (see loadOpenSong). */
let quietResume = false;

/**
 * (Re)loads the open song into the player at `at` seconds; plays on if `resume`.
 *
 * A tab-song that already plays (another part chosen) keeps playing while its new render is made
 * (a second or two) and swaps it in at the place it got to: no silence while you look at another
 * part. Everything else stops while it loads.
 */
async function loadOpenSong(at: number, resume: boolean): Promise<void> {
  const song = useSong.getState().song;
  if (!song || !songPlayer.attached) return;
  const { key, source } = wantedSource(song);
  const myKey = `${song.id}:${key}`;
  loadedKey = myKey;
  const store = useSong.getState();
  const swap = source === 'tab' && store.source === 'tab' && store.state === 'ready' && songPlayer.isLoaded;
  if (!swap) store.patch({ state: 'loading', source, playing: false });
  try {
    const current = () => loadedKey === myKey && useSong.getState().song?.id === song.id;
    const from = source === 'tab' ? await tabSongSource(song, current) : playerSource(song, source);
    if (!current()) return;
    let start = at;
    let playOn = resume;
    if (swap) {
      // Where the music got to meanwhile (it may have been paused or moved, too).
      start = songPlayer.position();
      playOn = useSong.getState().playing;
      useSong.getState().patch({ state: 'loading', playing: false });
    }
    const done = await songPlayer.load(from, song.duration, start);
    if (!done || useSong.getState().song?.id !== song.id) return;
    failedKey = null;
    applySettings(useSong.getState().song ?? song);
    // A swap goes on where the music was, without «Отсчёт»'s bar of clicks.
    quietResume = swap;
    try {
      useSong.getState().patch({ state: 'ready', playing: playOn });
    } finally {
      quietResume = false;
    }
  } catch (error) {
    if (error instanceof Overtaken) return;
    failedKey = loadedKey;
    loadedKey = null;
    useSong.getState().patch({
      state: 'error',
      message: L().actions.song.loadFailed(error instanceof Error ? error.message : String(error)),
    });
  }
}

/** True while the app itself switches the preset (not the user's choice). */
let programmaticPreset = false;

function selectPresetQuietly(index: number): void {
  programmaticPreset = true;
  try {
    useSettings.getState().selectPreset(index);
  } finally {
    programmaticPreset = false;
  }
}

/** The song's own amp preset («Свой звук у песни»). */
function selectSongPreset(song: Song): void {
  const settings = useSettings.getState();
  const index = settings.presets.findIndex((p) => p.id === song.player.presetId);
  if (index >= 0) selectPresetQuietly(index);
  else useSong.getState().updatePlayer({ presetId: currentPreset(settings).id });
}

/**
 * «Звук как в песне»: while it is on and the analysis heard a guitar, the amp takes the preset the
 * analysis chose plus its EQ change (the preset itself is not edited). Off: no EQ change.
 */
function applyTone(): void {
  const { song, analysis } = useSong.getState();
  const tone = song?.player.toneMatch ? (analysis?.tone ?? null) : null;
  const rt = useRuntime.getState();
  if (!tone) {
    if (rt.toneOffsets) rt.patch({ toneOffsets: null });
    return;
  }
  const settings = useSettings.getState();
  const index = settings.presets.findIndex((p) => p.id === tone.presetId);
  if (index >= 0 && index !== settings.presetIndex) selectPresetQuietly(index);
  const now = rt.toneOffsets;
  if (!now || now.bass !== tone.bass || now.mid !== tone.mid || now.treble !== tone.treble) {
    rt.patch({ toneOffsets: { bass: tone.bass, mid: tone.mid, treble: tone.treble } });
  }
}

function applyMaster(): void {
  songPlayer.setMaster(useSettings.getState().masterDb);
}

export function bindSong(): () => void {
  const offEnded = songPlayer.onEnded(() => useSong.getState().patch({ playing: false }));

  // The song's own audio context starts with the guitar's (after the first key press) and then
  // lives on: switching the guitar's latency mode does not touch the song.
  const offRuntime = useRuntime.subscribe((r, prev) => {
    if (r.status === prev.status || r.status !== 'running' || songPlayer.attached) return;
    applyMaster();
    void songPlayer
      .setOutputDevice(useSettings.getState().outputDeviceId)
      .then(() => songPlayer.attach())
      .then(() => loadOpenSong(0, false));
  });

  const offSong = useSong.subscribe((s, prev) => {
    const song = s.song;
    if (song?.id !== prev.song?.id) {
      if (!song) {
        loadedKey = null;
        songPlayer.unload();
        applyTone();
        return;
      }
      useSettings.getState().setLastSongId(song.id);
      selectSongPreset(song);
      analysisKey = null;
      wordsKey = null;
      applyTone();
      void loadAnalysis(song);
      void loadWords(song);
      void loadOpenSong(0, false);
      return;
    }
    if (!song || !prev.song) return;
    if (song.analysis !== prev.song.analysis) void loadAnalysis(song);
    if (song.transcript !== prev.song.transcript) void loadWords(song);
    if (s.analysis !== prev.analysis || song.barShift !== prev.song.barShift) {
      songPlayer.setGrid(beatGrid(song, s.analysis));
    }
    if (s.analysis && s.analysis !== prev.analysis) applyTuningOnce(song, s.analysis);
    if (s.analysis !== prev.analysis || song.player.toneMatch !== prev.song.player.toneMatch) applyTone();
    // Stems became ready, another model was chosen, or the song was opened again after a failure.
    const wanted = `${song.id}:${wantedSource(song).key}`;
    if (needsReload({ wanted, loaded: loadedKey, failed: failedKey, state: s.state, prevState: prev.state })) {
      void loadOpenSong(s.state === 'error' || prev.state === 'error' ? 0 : songPlayer.position(), s.playing);
      return;
    }
    const p = song.player;
    const q = prev.song.player;
    if (p.speed !== q.speed) songPlayer.setRate(p.speed);
    if (p.semitones !== q.semitones || p.cents !== q.cents) songPlayer.setPitch(p.semitones + p.cents / 100);
    if (p.loop !== q.loop) songPlayer.setLoop(p.loop);
    if (p.volumesDb !== q.volumesDb || p.muted !== q.muted || p.solo !== q.solo) songPlayer.setGains(stemGains(p));
    if (s.source !== prev.source) songPlayer.setBusDb(busDb(song, s.source));
    if (p.click !== q.click) songPlayer.setClick(p.click);
    if (p.countIn !== q.countIn) songPlayer.setCountIn(p.countIn);
    if (s.playing !== prev.playing) {
      if (s.playing) songPlayer.play({ countIn: !quietResume });
      else songPlayer.pause();
    }
  });

  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.masterDb !== prev.masterDb) applyMaster();
    if (s.outputDeviceId !== prev.outputDeviceId) void songPlayer.setOutputDevice(s.outputDeviceId);
    const song = useSong.getState().song;
    if (!song) return;
    if (s.songVolumeDb !== prev.songVolumeDb) songPlayer.setBusDb(busDb(song, useSong.getState().source));
    if (s.presetIndex !== prev.presetIndex && currentPreset(s).id !== song.player.presetId) {
      useSong.getState().updatePlayer({ presetId: currentPreset(s).id });
    }
    // Choosing a preset by hand wins over «Звук как в песне».
    if (s.presetIndex !== prev.presetIndex && !programmaticPreset && song.player.toneMatch && useSong.getState().analysis?.tone) {
      useSong.getState().updatePlayer({ toneMatch: false });
      useRuntime.getState().showToast(L().actions.practice.toneOff);
    }
  });

  // «Сразу играть»: the last song opens by itself once the service answers.
  let opened = false;
  const offLibrary = useLibrary.subscribe((lib) => {
    if (opened || lib.service !== 'online') return;
    opened = true;
    const last = useSettings.getState().lastSongId;
    if (!last || useSong.getState().song) return;
    if (lib.songs.some((song) => song.id === last)) void useSong.getState().openSong(last).catch(() => undefined);
    else useSettings.getState().setLastSongId(null);
  });

  if (import.meta.env.DEV) {
    // For checks from the browser console (dev builds only).
    (window as unknown as { __kvStores: object }).__kvStores = { useSong, useLibrary, useSettings, useRuntime };
  }

  return () => {
    offEnded();
    offRuntime();
    offSong();
    offSettings();
    offLibrary();
  };
}
