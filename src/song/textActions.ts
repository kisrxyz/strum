// What the stage-3 keys and buttons do: the view under the wave, lyrics (paste, files, the draft
// from the vocals, LRCLIB, line anchors, saving) and the tab (files, parts, bar sync), «Сцена».
import { refreshLibrary, useLibrary } from '../state/library';
import { L } from '../i18n';
import { lineAt } from '../lyrics/align';
import { toChordPro, toLrc } from '../lyrics/formats';
import { lrclibSearchUrl, pickLrclib, type LrclibHit } from '../lyrics/lrclib';
import { songLyrics } from '../lyrics/songLyrics';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { nudgeSync } from '../tab/sync';
import { isTextTab, textTabToAlphaTex } from '../tab/textTab';
import { api } from './api';
import { fmtTime } from './format';
import { songPlayer } from './player';
import { isTabSong, type Lyrics, type Song, type SongView } from './types';

const toast = (text: string, tone: 'info' | 'warn' = 'info') => useRuntime.getState().showToast(text, tone);
const VIEWS: SongView[] = ['chords', 'lyrics', 'tab', 'notes'];

/** Why the «Ноты» view is empty. */
export function notesMissing(song: {
  kind?: Song['kind'];
  activeModel: string | null;
  analysis: { status: string; version?: number; notesMissing?: boolean } | null;
}): string {
  const t = L().actions.notes;
  if (isTabSong(song)) return t.tabPart;
  if (!song.activeModel) return t.needStems;
  if (song.analysis?.notesMissing) return t.filesMissing;
  if (song.analysis?.status === 'queued' || song.analysis?.status === 'running') return t.running;
  if (song.analysis?.status === 'error') return t.failed;
  return t.none;
}

/** The open song, or null with a word to the user. */
function openSong() {
  const song = useSong.getState().song;
  if (!song) toast(L().actions.song.openFirst);
  return song;
}

const current = () => {
  const { song, analysis, words } = useSong.getState();
  return { song, lyrics: songLyrics(song, analysis, words) };
};

function setLyrics(lyrics: Lyrics | null, view: SongView | null = 'lyrics'): void {
  const store = useSong.getState();
  store.updateLyrics(lyrics);
  if (view && store.song) store.updatePlayer({ view });
}

/** Stores the tab file for the open song and shows it. */
async function putTab(name: string, data: BodyInit): Promise<void> {
  const song = openSong();
  if (!song) return;
  try {
    const fresh = await api.putTab(song.id, name, data);
    const store = useSong.getState();
    if (store.song?.id !== song.id) return;
    store.patch({ song: { ...store.song, tab: fresh.tab } });
    store.updatePlayer({ view: 'tab' });
    toast(L().actions.tab.added(name));
  } catch (error) {
    toast(error instanceof Error ? error.message : L().actions.tab.saveFailed, 'warn');
  }
}

let pendingRemove: { what: 'lyrics' | 'tab'; until: number } | null = null;

/** Two presses within 4 s, no dialogs. True on the second one. */
function twice(what: 'lyrics' | 'tab', warning: string): boolean {
  const now = Date.now();
  if (!pendingRemove || pendingRemove.what !== what || pendingRemove.until < now) {
    pendingRemove = { what, until: now + 4000 };
    toast(warning, 'warn');
    return false;
  }
  pendingRemove = null;
  return true;
}

function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from the song's title (characters Windows refuses taken out). */
const fileBase = (title: string) => title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || L().actions.lyrics.untitled;

export const textActions = {
  /** W: chords → lyrics → tab → notes → chords. */
  nextView(): void {
    const song = openSong();
    if (!song) return;
    const next = VIEWS[(VIEWS.indexOf(song.player.view) + 1) % VIEWS.length];
    useSong.getState().updatePlayer({ view: next });
    if (next === 'lyrics' && !song.lyrics) toast(L().actions.lyrics.none);
    if (next === 'tab' && !song.tab) toast(L().actions.tab.noneHint);
    if (next === 'notes') {
      const notes = song.guitarNotes ?? useSong.getState().analysis?.notes;
      if (!notes?.length) toast(notesMissing(song));
    }
  },

  /** «;»: in the lyrics — the line starts now; in the tab — the tab one bar later. */
  anchorHere(): void {
    const { song, lyrics } = current();
    if (!song) return void openSong();
    if (song.player.view === 'tab') return textActions.nudgeTab(1);
    if (!song.lyrics || !lyrics) return toast(L().actions.lyrics.none);
    const pos = songPlayer.position();
    const heard = (useSong.getState().words?.words.length ?? 0) > 0 || lyrics.doc.lines.some((l) => l.time !== null);
    let line: number;
    if (heard && lyrics.lines) {
      // The text is in time already: «;» moves the line that starts nearest to now.
      const i = Math.max(0, lineAt(lyrics.lines, pos));
      const next = lyrics.lines[i + 1];
      line = next && Math.abs(next.start - pos) < Math.abs(lyrics.lines[i].start - pos) ? next.line : lyrics.lines[i].line;
    } else {
      // Nothing heard: tapping along times the text, sung line after sung line (the instrumental
      // lines fill the gaps by themselves).
      const after = song.lyrics.anchors.reduce((max, a) => Math.max(max, a.line), -1);
      line = lyrics.doc.lines.findIndex((l, i) => i > after && l.text.trim() !== '');
      if (line < 0) return toast(L().actions.lyrics.allMarked);
    }
    const anchors = [...song.lyrics.anchors.filter((a) => a.line !== line), { line, time: pos }].sort((a, b) => a.line - b.line);
    useSong.getState().updateLyrics({ ...song.lyrics, anchors });
    const text = lyrics.doc.lines[line]?.text.trim() ?? '';
    toast(
      text
        ? L().actions.lyrics.lineFrom(text.length > 40 ? `${text.slice(0, 40)}…` : text, fmtTime(pos))
        : L().actions.lyrics.instrumentalFrom(fmtTime(pos)),
    );
  },

  /** Shift+«;»: in the lyrics — the current line's mark goes; in the tab — the tab one bar earlier. */
  anchorClear(): void {
    const { song, lyrics } = current();
    if (!song) return void openSong();
    if (song.player.view === 'tab') return textActions.nudgeTab(-1);
    if (!song.lyrics || !lyrics?.lines) return;
    const i = lineAt(lyrics.lines, songPlayer.position());
    const line = i >= 0 ? lyrics.lines[i].line : -1;
    if (!song.lyrics.anchors.some((a) => a.line === line)) return toast(L().actions.lyrics.noMark);
    useSong.getState().updateLyrics({ ...song.lyrics, anchors: song.lyrics.anchors.filter((a) => a.line !== line) });
    toast(L().actions.lyrics.markRemoved);
  },

  nudgeTab(dir: 1 | -1): void {
    const song = openSong();
    if (isTabSong(song)) return toast(L().actions.tab.tabSongSync);
    const sync = useRuntime.getState().tabSync;
    if (!song?.tab || !sync) return toast(L().actions.tab.none);
    const next = nudgeSync(sync, dir);
    useSong.getState().updateTab({ offset: next.offset, ratio: next.ratio });
    toast(dir > 0 ? L().actions.tab.later : L().actions.tab.earlier);
  },

  /** «'»: the tab's next part. */
  nextTabTrack(): void {
    const song = openSong();
    if (!song?.tab) return toast(L().actions.tab.none);
    textActions.pickTabTrack(song.tab.track + 1);
  },

  /** A part picked in the tab's list (or the next one on «'»). In a tab-song it is also what G mutes: the sound is made again for it. */
  pickTabTrack(index: number): void {
    const song = openSong();
    const shown = useRuntime.getState().tabTracks;
    // A tab-song knows its parts from its render, in any view.
    const tracks = shown.length ? shown : isTabSong(song) ? useSong.getState().parts : [];
    if (!song?.tab || !tracks.length) return toast(L().actions.tab.none);
    const track = index % tracks.length;
    if (track === song.tab.track) {
      if (tracks.length === 1) toast(L().actions.tab.onePart);
      return;
    }
    useSong.getState().updateTab({ track });
    const name = tracks[track] || L().actions.tab.track(track + 1);
    toast(isTabSong(song) ? L().actions.tab.yourPart(name) : L().actions.tab.part(name));
  },

  /** Shift+«'»: notes above the tab. */
  toggleNotation(): void {
    const song = openSong();
    if (!song?.tab) return toast(L().actions.tab.none);
    useSong.getState().updateTab({ notation: !song.tab.notation });
  },

  /** «`»: «Сцена» — the whole screen. Must run inside the key press (a user gesture). */
  toggleStage(): void {
    const rt = useRuntime.getState();
    if (rt.stage) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      rt.patch({ stage: false });
      return;
    }
    if (!openSong()) return;
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    rt.patch({ stage: true });
  },

  /** Ctrl+V on the song screen: a text tab becomes the tab, anything else the lyrics. */
  async pasteText(text: string): Promise<void> {
    const song = openSong();
    if (!song || !text.trim()) return;
    if (isTextTab(text)) {
      const tex = textTabToAlphaTex(text);
      if (tex) return putTab(`${L().actions.tab.pastedName}.alphatex`, tex);
    }
    setLyrics({ source: 'paste', text, anchors: [], shift: null });
    toast(song.lyrics ? L().actions.lyrics.replaced : L().actions.lyrics.pasted);
  },

  /** A dropped .txt / .cho / .lrc: the lyrics (or a text tab). */
  async addLyricsFile(file: File): Promise<void> {
    if (!openSong()) return;
    const text = await file.text();
    if (isTextTab(text)) {
      const tex = textTabToAlphaTex(text);
      if (tex) return putTab(`${file.name.replace(/\.[^.]+$/, '')}.alphatex`, tex);
    }
    setLyrics({ source: 'file', text, anchors: [], shift: null });
    toast(L().actions.lyrics.fromFile(file.name));
  },

  /** A dropped Guitar Pro / MusicXML file: the song's tab. */
  async addTabFile(file: File): Promise<void> {
    await putTab(file.name, file);
  },

  /** «Черновик по вокалу»: the words the service heard become the lyrics. */
  async useDraft(): Promise<void> {
    const { song, words } = useSong.getState();
    if (!song) return void openSong();
    if (isTabSong(song)) return toast(L().actions.lyrics.tabSongNoVoice);
    const info = song.transcript;
    if (words?.lines.length) {
      setLyrics({ source: 'draft', text: words.lines.map((l) => l.text).join('\n'), anchors: [], shift: null });
      toast(L().actions.lyrics.draft);
      return;
    }
    if (words && !words.lines.length) return toast(L().actions.lyrics.noWords);
    if (info?.status === 'queued' || info?.status === 'running') return toast(L().actions.lyrics.transcribing);
    // The installed app has no words model until it is asked for (2.9 GB).
    const health = useLibrary.getState().health;
    if (health?.components?.canInstall && health.lyricsModel && !health.lyricsModel.ready) {
      if (health.components.words.state === 'installing') return toast(L().actions.lyrics.wordsDownloading);
      try {
        await api.installComponent('words');
        toast(L().actions.lyrics.wordsDownload);
        void refreshLibrary();
      } catch (error) {
        toast(error instanceof Error ? error.message : L().actions.lyrics.transcribeFailed, 'warn');
      }
      return;
    }
    try {
      await api.transcribe(song.id);
      toast(info?.status === 'error' ? L().actions.lyrics.transcribeAgain : L().actions.lyrics.transcribeStarted);
    } catch (error) {
      toast(error instanceof Error ? error.message : L().actions.lyrics.transcribeFailed, 'warn');
    }
  },

  /** «Найти текст в интернете»: LRCLIB, only the artist, the title and the length leave the laptop. */
  async findOnline(): Promise<void> {
    const song = openSong();
    if (!song) return;
    toast(L().actions.lyrics.searching);
    let hits: LrclibHit[];
    try {
      const response = await fetch(lrclibSearchUrl(song.artist, song.title));
      if (!response.ok) throw new Error(String(response.status));
      hits = (await response.json()) as LrclibHit[];
    } catch {
      return toast(L().actions.lyrics.searchOffline, 'warn');
    }
    const hit = pickLrclib(hits, song.duration);
    if (!hit) return toast(L().actions.lyrics.notFound(song.title), 'warn');
    setLyrics({ source: 'lrclib', text: hit.syncedLyrics || hit.plainLyrics || '', anchors: [], shift: null });
    toast(hit.syncedLyrics ? L().actions.lyrics.foundTimed : L().actions.lyrics.foundPlain);
  },

  removeLyrics(): void {
    const song = openSong();
    if (!song?.lyrics) return;
    if (!twice('lyrics', L().actions.lyrics.removeAgain)) return;
    setLyrics(null, null);
    useSong.getState().patch({ editingLyrics: false });
    toast(L().actions.lyrics.removed);
  },

  async removeTab(): Promise<void> {
    const song = openSong();
    if (isTabSong(song)) return toast(L().actions.tab.tabSongRemove);
    if (!song?.tab) return;
    if (!twice('tab', L().actions.tab.removeAgain)) return;
    try {
      const fresh = await api.deleteTab(song.id);
      const store = useSong.getState();
      if (store.song?.id === song.id) store.patch({ song: { ...store.song, tab: fresh.tab } });
      toast(L().actions.tab.removed);
    } catch (error) {
      toast(error instanceof Error ? error.message : L().actions.tab.removeFailed, 'warn');
    }
  },

  saveLrc(): void {
    const { song, lyrics } = current();
    if (!song || !lyrics) return;
    if (!lyrics.lines) return toast(L().actions.lyrics.noTimes);
    download(toLrc(lyrics.doc, lyrics.lines, song.title, song.artist), `${fileBase(song.title)}.lrc`);
  },

  saveChordPro(): void {
    const { song, lyrics } = current();
    if (!song || !lyrics) return;
    download(toChordPro(lyrics.doc, song.title, song.artist), `${fileBase(song.title)}.cho`);
  },

  /** The text's chords back as written (undo the automatic key shift), or found again. */
  toggleShift(): void {
    const { song, lyrics } = current();
    if (!song?.lyrics || !lyrics) return;
    useSong.getState().updateLyrics({ ...song.lyrics, shift: lyrics.autoShift && lyrics.shift ? 0 : null });
  },
};
