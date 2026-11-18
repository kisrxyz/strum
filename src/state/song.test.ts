import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Song } from '../song/types';
import { createSaver, mergeSongPatch, useSong, withDefaults, type SongPatch } from './song';

const song = (patch: Partial<Song> = {}): Song => ({
  version: 1,
  id: 'abcdef012345',
  title: 'Кукушка',
  artist: 'Кино',
  fileName: 'Кино - Кукушка.mp3',
  originalExt: 'mp3',
  addedAt: '2026-11-07T10:00:00+00:00',
  duration: 200,
  sampleRate: 44100,
  loudnessDb: -12,
  mixGainDb: 0,
  stems: { bs_roformer_sw: { status: 'running', progress: 0.3 } },
  activeModel: null,
  notes: '',
  player: {
    speed: 1,
    semitones: 0,
    cents: 0,
    volumesDb: { vocals: 0, drums: 0, bass: 0, guitar: 0, piano: 0, other: 0 },
    muted: ['guitar'],
    solo: null,
    loop: { start: 0, end: 0, on: false },
    bookmarks: [],
    presetId: null,
    capo: 0,
    tuning: 'standard',
    simpleChords: false,
    mode: 'play',
    reveal: 0,
    countIn: false,
    click: false,
    toneMatch: true,
    tuningApplied: false,
    view: 'chords',
  },
  analysis: null,
  chords: null,
  barShift: 0,
  transcript: null,
  lyrics: null,
  tab: null,
  guitarNotes: null,
  lists: [],
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSaver', () => {
  it('sends one merged patch half a second after the last change', () => {
    const sent: SongPatch[] = [];
    const saver = createSaver<SongPatch>((p) => (sent.push(p), Promise.resolve()), 500, mergeSongPatch);
    saver.push({ player: { speed: 0.8 } });
    vi.advanceTimersByTime(300);
    saver.push({ player: { semitones: -1, volumesDb: { bass: -6 } as Song['player']['volumesDb'] } });
    saver.push({ player: { volumesDb: { vocals: -3 } as Song['player']['volumesDb'] } });
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ player: { speed: 0.8, semitones: -1, volumesDb: { bass: -6, vocals: -3 } } }]);
  });

  it('flush sends at once and only once', async () => {
    const sent: SongPatch[] = [];
    const saver = createSaver<SongPatch>((p) => (sent.push(p), Promise.resolve()), 500, mergeSongPatch);
    saver.push({ notes: 'медленно' });
    await saver.flush();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([{ notes: 'медленно' }]);
    await saver.flush();
    expect(sent.length).toBe(1);
  });
});

describe('useSong.openSong', () => {
  it('opening the song that is already open keeps it ready (no endless loading)', async () => {
    vi.useRealTimers();
    const fresh = song({ title: 'Кукушка (новое имя)' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(fresh), { status: 200 }))));
    useSong.setState({ song: song(), state: 'ready', source: 'mix', playing: true });
    await useSong.getState().openSong('abcdef012345');
    expect(useSong.getState().state).toBe('ready');
    expect(useSong.getState().playing).toBe(true);
    expect(useSong.getState().song?.title).toBe('Кукушка (новое имя)');
    vi.unstubAllGlobals();
  });
});

describe('useSong.syncFromLibrary', () => {
  it('takes the stems from the server and keeps local player edits that are not saved yet', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    useSong.setState({ song: song(), state: 'ready' });
    useSong.getState().updatePlayer({ speed: 0.8 });
    const fromServer = song({ stems: { bs_roformer_sw: { status: 'ready' } }, activeModel: 'bs_roformer_sw' });
    useSong.getState().syncFromLibrary(fromServer);
    const now = useSong.getState().song!;
    expect(now.player.speed).toBe(0.8);
    expect(now.stems.bs_roformer_sw?.status).toBe('ready');
    expect(now.activeModel).toBe('bs_roformer_sw');
    vi.unstubAllGlobals();
  });

  it('ignores other songs', () => {
    useSong.setState({ song: song(), state: 'ready' });
    useSong.getState().syncFromLibrary(song({ id: '111111111111', title: 'Другая' }));
    expect(useSong.getState().song?.title).toBe('Кукушка');
  });
});

describe('withDefaults', () => {
  it('gives a stage-1 song the stage-2 fields', () => {
    const { analysis: _a, chords: _c, barShift: _b, ...old } = song();
    const { capo: _capo, mode: _mode, toneMatch: _tone, ...oldPlayer } = old.player;
    const filled = withDefaults({ ...old, player: oldPlayer } as unknown as Song);
    expect(filled.analysis).toBeNull();
    expect(filled.chords).toBeNull();
    expect(filled.barShift).toBe(0);
    expect(filled.player.capo).toBe(0);
    expect(filled.player.mode).toBe('play');
    expect(filled.player.toneMatch).toBe(true);
    expect(filled.player.speed).toBe(1);
  });
});

describe('useSong chord edits', () => {
  it('keeps a chord edit whose save is still on its way when an older copy arrives', async () => {
    const answer = () => Promise.resolve(new Response(JSON.stringify(song()), { status: 200 }));
    // GET answers at once; the PATCH never comes back (it is "on its way")
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => (init?.method === 'PATCH' ? new Promise(() => undefined) : answer())));
    useSong.setState({ song: null, state: 'idle' });
    await useSong.getState().openSong('abcdef012345');
    const edited = [{ start: 0, end: 200, chord: 'A:min' }];
    useSong.getState().updateSong({ chords: edited, barShift: 2 });
    vi.advanceTimersByTime(600); // the saver has sent the PATCH
    useSong.getState().syncFromLibrary(song()); // a poll answered before the PATCH landed
    expect(useSong.getState().song!.chords).toEqual(edited);
    expect(useSong.getState().song!.barShift).toBe(2);
    vi.unstubAllGlobals();
  });

  it('keeps unsaved chord edits when the service sends its older copy', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(song()), { status: 200 }))));
    useSong.setState({ song: null, state: 'idle' });
    await useSong.getState().openSong('abcdef012345'); // creates the saver; the fake timers hold the PATCH
    const edited = [{ start: 0, end: 200, chord: 'A:min' }];
    useSong.getState().updateSong({ chords: edited, barShift: 1 });
    useSong.getState().syncFromLibrary(song({ analysis: { status: 'ready', finishedAt: 't2' } }));
    const now = useSong.getState().song!;
    expect(now.chords).toEqual(edited);
    expect(now.barShift).toBe(1);
    expect(now.analysis?.finishedAt).toBe('t2');
    vi.unstubAllGlobals();
  });
});
