// Adding a song: the browser decodes the file itself (mp3, m4a, flac, wav — no ffmpeg needed) and
// sends the service the original plus a 44.1 kHz stereo float WAV, which the models expect.
import { classifyDrop, fileExtension } from '../audio/assetFiles';
import { L } from '../i18n';
import { pollSoon, refreshLibrary, useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { inspectTab } from '../tab/tabSource';
import { api } from './api';
import { encodeWavFloat32 } from './wav';

const RATE = 44100;
const unreadable = () => L().actions.add.unreadable;

export async function decodeForUpload(file: File): Promise<{ wav: ArrayBuffer; duration: number }> {
  let decoded: AudioBuffer;
  try {
    // decodeAudioData resamples to the context's rate.
    decoded = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(unreadable());
  }
  if (!decoded.length) throw new Error(unreadable());
  // Rendering into a stereo destination lets Web Audio up-mix mono and down-mix 5.1.
  const ctx = new OfflineAudioContext(2, decoded.length, RATE);
  const source = new AudioBufferSourceNode(ctx, { buffer: decoded });
  source.connect(ctx.destination);
  source.start();
  const stereo = await ctx.startRendering();
  return {
    wav: encodeWavFloat32([stereo.getChannelData(0), stereo.getChannelData(1)], RATE),
    duration: stereo.duration,
  };
}

const minutes = (seconds: number) => Math.round(seconds / 60);

async function importOne(file: File): Promise<void> {
  const toast = useRuntime.getState().showToast;
  const library = useLibrary.getState();
  if (library.service !== 'online') {
    toast(L().service.offline, 'warn');
    return;
  }
  const setPhase = (phase: 'decode' | 'upload' | 'save', progress = 0) =>
    useLibrary.setState({ importing: { name: file.name, phase, progress } });
  try {
    setPhase('decode');
    const { wav, duration } = await decodeForUpload(file);
    const max = library.health?.maxSeconds ?? 720;
    if (duration > max) throw new Error(L().actions.add.tooLong(minutes(max)));
    setPhase('upload');
    const { song, created } = await api.addSong(file, wav, (f) => setPhase(f >= 1 ? 'save' : 'upload', f));
    await refreshLibrary();
    pollSoon();
    toast(created ? L().actions.add.added(song.title) : L().actions.add.exists(song.title));
    await useSong.getState().openSong(song.id);
    useRuntime.getState().patch({ view: 'song' });
  } catch (error) {
    toast(error instanceof Error ? error.message : unreadable(), 'warn');
  } finally {
    useLibrary.setState({ importing: null });
  }
}

/**
 * A tab file becomes a song of its own: the app reads it (title, parts, length, loudness) and the
 * service keeps the file. It plays with the tab's own drums, bass and parts.
 */
async function importTab(file: File): Promise<void> {
  const toast = useRuntime.getState().showToast;
  const library = useLibrary.getState();
  if (library.service !== 'online') {
    toast(L().service.offline, 'warn');
    return;
  }
  const setPhase = (phase: 'decode' | 'save') => useLibrary.setState({ importing: { name: file.name, phase, progress: 0 } });
  try {
    setPhase('decode');
    const info = await inspectTab(new Uint8Array(await file.arrayBuffer()), fileExtension(file.name));
    const max = library.health?.maxSeconds ?? 720;
    if (info.duration > max) throw new Error(L().actions.tab.tooLong(minutes(max)));
    setPhase('save');
    const { song, created } = await api.addTabSong(file, info);
    await refreshLibrary();
    toast(created ? L().actions.tab.addedSong(song.title) : L().actions.add.exists(song.title));
    await useSong.getState().openSong(song.id);
    useRuntime.getState().patch({ view: 'song' });
  } catch (error) {
    toast(error instanceof Error ? error.message : L().actions.tab.errors.unreadable, 'warn');
  } finally {
    useLibrary.setState({ importing: null });
  }
}

/** Adds dropped or picked song and tab files, one after another; the last one opens. */
export async function importFiles(files: File[]): Promise<void> {
  for (const file of files) await (classifyDrop(file.name, null) === 'tab' ? importTab(file) : importOne(file));
}
