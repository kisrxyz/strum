// What the song keys and buttons do. They change useSong / useSettings; seeking is the one direct
// player call (the position is not kept in a store, like engine.start() is called directly).
import { sectionLabel } from './sections';
import { L } from '../i18n';
import { fileLang } from '../i18n/lang';
import { sectionAt, snapToBar, stepSection } from '../music/bars';
import { TUNINGS, TUNING_ORDER } from '../music/tunings';
import { pollSoon, refreshLibrary, useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { api } from './api';
import { fmtTime } from './format';
import { songBars } from './grid';
import { exportBody } from './mix';
import { songPlayer } from './player';
import { MIN_LOOP, loopActive, markA, markB, nextBookmark, seekBy, stepPitch, stepSpeed } from './schedule';
import { isTabSong, MODELS, MODEL_NAMES, type ModelId, type RevealLevel } from './types';

const toast = (text: string, tone: 'info' | 'warn' = 'info') => useRuntime.getState().showToast(text, tone);
const SEEK_STEP = 5;

/** The open song when the player can act on it; tells the user why not otherwise. */
function readySong() {
  const { song, state } = useSong.getState();
  if (!song) {
    toast(L().actions.song.openFirst);
    return null;
  }
  if (state !== 'ready') {
    toast(state === 'error' ? L().actions.song.notLoaded : L().actions.song.loading);
    return null;
  }
  return song;
}

const loopText = (start: number, end: number) => `${fmtTime(start)}–${fmtTime(end)}`;

/** The open song's bars ([] until the analysis is there). */
const currentBars = () => songBars(useSong.getState().song, useSong.getState().analysis);

/** With bars, loop edges stick to the nearest bar line. */
const snap = (t: number) => {
  const bars = currentBars();
  return bars.length ? snapToBar(bars, t) : t;
};

/** What a hint level shows, in the current language. */
const hint = (level: RevealLevel): string => L().actions.ear.hints[level];

const noAnalysis = () => {
  const info = useSong.getState().song?.analysis;
  toast(info?.status === 'error' ? L().actions.analysis.failed : L().actions.analysis.running);
};

export const readyModels = (stems: Partial<Record<ModelId, { status: string }>>): ModelId[] =>
  MODELS.filter((m) => stems[m]?.status === 'ready');

export const songActions = {
  togglePlay(): void {
    songPlayer.resume();
    if (!readySong()) return;
    useSong.getState().patch({ playing: !useSong.getState().playing });
  },

  seekTo(pos: number): void {
    if (readySong()) songPlayer.seek(pos);
  },

  seekBy(delta: number): void {
    const song = readySong();
    if (song) songPlayer.seek(seekBy(songPlayer.position(), delta, song.player.loop, song.duration));
  },

  seekStep(dir: 1 | -1): void {
    songActions.seekBy(dir * SEEK_STEP);
  },

  home(): void {
    const song = readySong();
    if (song) songPlayer.seek(loopActive(song.player.loop) ? song.player.loop.start : 0);
  },

  markA(): void {
    const song = readySong();
    if (!song) return;
    const loop = markA(song.player.loop, snap(songPlayer.position()), song.duration);
    useSong.getState().updatePlayer({ loop });
    toast(loop.end > loop.start ? L().actions.loop.set(loopText(loop.start, loop.end)) : L().actions.loop.start(fmtTime(loop.start)));
  },

  markB(): void {
    const song = readySong();
    if (!song) return;
    let end = snap(songPlayer.position());
    const bars = currentBars();
    if (bars.length && end - song.player.loop.start < MIN_LOOP) {
      // B pressed less than half a bar after A: the loop is that one bar.
      const bar = bars.find((b) => b.start >= song.player.loop.start - 0.01);
      if (bar) end = bar.end;
    }
    const loop = markB(song.player.loop, end);
    if (!loop) {
      toast(L().actions.loop.needStart);
      return;
    }
    useSong.getState().updatePlayer({ loop });
    toast(L().actions.loop.set(loopText(loop.start, loop.end)));
  },

  /** Drag on the waveform: with bars, both edges stick to bar lines (at least one bar). */
  setLoop(start: number, end: number): void {
    const song = readySong();
    if (!song) return;
    const bars = currentBars();
    let a = start;
    let b = end;
    if (bars.length) {
      a = snapToBar(bars, start);
      b = snapToBar(bars, end);
      if (b - a < MIN_LOOP) {
        const index = bars.findIndex((bar) => bar.start >= a - 0.01);
        b = index >= 0 ? bars[index].end : b;
      }
    }
    if (b - a < MIN_LOOP) return;
    useSong.getState().updatePlayer({ loop: { start: a, end: b, on: true } });
  },

  toggleLoop(): void {
    const song = readySong();
    if (!song) return;
    const loop = song.player.loop;
    if (loop.end - loop.start < MIN_LOOP) {
      toast(L().actions.loop.none);
      return;
    }
    useSong.getState().updatePlayer({ loop: { ...loop, on: !loop.on } });
  },

  stepSpeed(dir: 1 | -1): void {
    const song = useSong.getState().song;
    if (song) useSong.getState().updatePlayer({ speed: stepSpeed(song.player.speed, dir) });
  },

  setSpeed(speed: number): void {
    if (useSong.getState().song) useSong.getState().updatePlayer({ speed });
  },

  stepPitch(dir: 1 | -1, fine: boolean): void {
    const song = useSong.getState().song;
    if (song) useSong.getState().updatePlayer(stepPitch(song.player, dir, fine));
  },

  resetPitch(): void {
    if (useSong.getState().song) useSong.getState().updatePlayer({ semitones: 0, cents: 0 });
  },

  /** G: the original guitarist on / off. */
  toggleGuitar(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const muted = song.player.muted.includes('guitar')
      ? song.player.muted.filter((s) => s !== 'guitar')
      : [...song.player.muted, 'guitar' as const];
    useSong.getState().updatePlayer({ muted, solo: null });
    toast(muted.includes('guitar') ? L().actions.mix.guitarOff : L().actions.mix.guitarOn);
  },

  /** S: only the original guitar, to hear the part. */
  soloGuitar(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const solo = song.player.solo === 'guitar' ? null : 'guitar';
    useSong.getState().updatePlayer({ solo });
    toast(solo ? L().actions.mix.guitarOnly : L().actions.mix.fullBand);
  },

  addBookmark(): void {
    const song = readySong();
    if (!song) return;
    const { loop, bookmarks } = song.player;
    if (loop.end - loop.start < MIN_LOOP) {
      toast(L().actions.loop.needLoop);
      return;
    }
    const name = L().actions.bookmark.name(bookmarks.length + 1);
    useSong.getState().updatePlayer({ bookmarks: [...bookmarks, { name, start: loop.start, end: loop.end }] });
    toast(L().actions.bookmark.added(name, loopText(loop.start, loop.end)));
  },

  goToBookmark(index: number): void {
    const song = readySong();
    const mark = song?.player.bookmarks[index];
    if (!mark) return;
    useSong.getState().updatePlayer({ loop: { start: mark.start, end: mark.end, on: true } });
    songPlayer.seek(mark.start);
  },

  nextBookmark(): void {
    const song = readySong();
    if (!song) return;
    const index = nextBookmark(song.player.bookmarks, song.player.loop);
    if (index < 0) {
      toast(L().actions.bookmark.none);
      return;
    }
    songActions.goToBookmark(index);
    toast(`${song.player.bookmarks[index].name}`);
  },

  removeBookmark(index: number): void {
    const song = useSong.getState().song;
    if (song) useSong.getState().updatePlayer({ bookmarks: song.player.bookmarks.filter((_, i) => i !== index) });
  },

  /** N: the other model's stems, at the same place. */
  nextModel(): void {
    const song = useSong.getState().song;
    if (!song) return;
    if (isTabSong(song)) {
      toast(L().actions.mix.tabSongStems);
      return;
    }
    const ready = readyModels(song.stems);
    if (ready.length < 2) {
      toast(L().actions.mix.noOtherStems);
      return;
    }
    const next = ready[(ready.indexOf(song.activeModel ?? ready[0]) + 1) % ready.length];
    useSong.getState().updateSong({ activeModel: next });
    toast(L().actions.mix.model(MODEL_NAMES[next]));
  },

  /** H: «Играть» ↔ «Снять на слух». The ear mode starts with everything hidden. */
  toggleMode(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const ear = song.player.mode === 'play';
    useSong.getState().updatePlayer({ mode: ear ? 'ear' : 'play', reveal: 0 });
    useSong.getState().patch({ editIndex: null });
    toast(ear ? L().actions.ear.on : L().actions.ear.off);
  },

  /** J: the next hint in «Снять на слух». */
  nextHint(): void {
    const song = useSong.getState().song;
    if (!song) return;
    if (song.player.mode !== 'ear') {
      toast(L().actions.ear.onlyInEar);
      return;
    }
    const reveal = Math.min(3, song.player.reveal + 1) as RevealLevel;
    useSong.getState().updatePlayer({ reveal });
    toast(hint(reveal));
  },

  /** Shift+H: hide everything again (an open chord correction too: it shows the chord's name). */
  hideHints(): void {
    const song = useSong.getState().song;
    if (!song || song.player.mode !== 'ear') return;
    useSong.getState().updatePlayer({ reveal: 0 });
    useSong.getState().patch({ editIndex: null });
    toast(hint(0));
  },

  toggleClick(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const click = !song.player.click;
    useSong.getState().updatePlayer({ click });
    if (click && !currentBars().length) noAnalysis();
    else toast(click ? L().actions.practice.clickOn : L().actions.practice.clickOff);
  },

  toggleCountIn(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const countIn = !song.player.countIn;
    useSong.getState().updatePlayer({ countIn });
    if (countIn && !currentBars().length) noAnalysis();
    else toast(countIn ? L().actions.practice.countInOn : L().actions.practice.countInOff);
  },

  toggleSimple(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const simpleChords = !song.player.simpleChords;
    useSong.getState().updatePlayer({ simpleChords });
    toast(simpleChords ? L().actions.practice.simpleOn : L().actions.practice.simpleOff);
  },

  stepCapo(dir: 1 | -1): void {
    const song = useSong.getState().song;
    if (!song) return;
    const capo = Math.max(0, Math.min(9, song.player.capo + dir));
    if (capo === song.player.capo) return;
    useSong.getState().updatePlayer({ capo });
    toast(capo ? L().actions.practice.capo(capo) : L().actions.practice.noCapo);
  },

  /** Shift+[ / Shift+]: the bar lines move by a beat (the analysis got the first beat wrong). */
  shiftBars(dir: 1 | -1): void {
    const song = useSong.getState().song;
    if (!song) return;
    if (!useSong.getState().analysis) {
      noAnalysis();
      return;
    }
    const barShift = Math.max(-12, Math.min(12, song.barShift + dir));
    useSong.getState().updateSong({ barShift });
    toast(dir > 0 ? L().actions.analysis.barsLater : L().actions.analysis.barsEarlier);
  },

  nextTuning(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const tuning = TUNING_ORDER[(TUNING_ORDER.indexOf(song.player.tuning) + 1) % TUNING_ORDER.length];
    useSong.getState().updatePlayer({ tuning });
    toast(L().actions.practice.tuning(TUNINGS[tuning].name));
  },

  nextVoicing(): void {
    useSong.getState().patch({ voicing: useSong.getState().voicing + 1 });
  },

  /** F: show or hide the neck in the current view; showing it closes the mixer, which sits in its place. */
  toggleNeck(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const view = song.player.view;
    const shown = useSettings.getState().neckShown[view];
    if (shown && useSong.getState().mixerOpen) {
      useSong.getState().patch({ mixerOpen: false });
      return;
    }
    useSettings.getState().toggleNeck(view);
    if (!shown) useSong.getState().patch({ mixerOpen: false });
  },

  /** Shift+F: the neck must be visible to see what it shows now. */
  showNeck(): void {
    const song = useSong.getState().song;
    if (!song) return;
    if (!useSettings.getState().neckShown[song.player.view]) useSettings.getState().toggleNeck(song.player.view);
    useSong.getState().patch({ mixerOpen: false });
  },

  /** The song's options: the panel on the right, open or closed. */
  toggleSettings(): void {
    useRuntime.getState().patch({ songSettings: !useRuntime.getState().songSettings });
  },

  /** The mixer in the neck's place, or closed again. */
  toggleMixer(): void {
    useSong.getState().patch({ mixerOpen: !useSong.getState().mixerOpen });
  },

  closePanels(): void {
    useSong.getState().patch({ mixerOpen: false });
    useRuntime.getState().patch({ songSettings: false });
  },

  /** Y: «Звук как в песне» on / off. */
  toggleToneMatch(): void {
    const song = useSong.getState().song;
    if (!song) return;
    const toneMatch = !song.player.toneMatch;
    useSong.getState().updatePlayer({ toneMatch });
    const tone = useSong.getState().analysis?.tone;
    if (!toneMatch) toast(L().actions.practice.toneOff);
    else if (tone) toast(L().actions.practice.toneOn);
    else toast(L().actions.practice.toneWaiting);
  },

  /** Q: loop the section the song is in. */
  loopSection(): void {
    const song = readySong();
    const sections = useSong.getState().analysis?.sections ?? [];
    if (!song) return;
    const index = sectionAt(sections, songPlayer.position());
    if (index < 0) {
      if (!useSong.getState().analysis) noAnalysis();
      else toast(L().actions.analysis.noSections);
      return;
    }
    const part = sections[index];
    const start = snap(part.start);
    const end = Math.max(snap(part.end), start + MIN_LOOP);
    useSong.getState().updatePlayer({ loop: { start, end, on: true } });
    songPlayer.seek(start);
    toast(L().actions.loop.section(sectionLabel(sections, index, isTabSong(song))));
  },

  /** Shift+← / Shift+→: the previous or the next section. */
  stepSection(dir: 1 | -1): void {
    const song = readySong();
    const sections = useSong.getState().analysis?.sections ?? [];
    if (!song) return;
    if (!sections.length) {
      if (!useSong.getState().analysis) noAnalysis();
      else toast(L().actions.analysis.noSections);
      return;
    }
    const index = stepSection(sections, songPlayer.position(), dir);
    if (index < 0) return;
    const part = sections[index];
    const start = snap(part.start);
    // With a loop on, the loop moves to that section (like X with bookmarks): otherwise the jump
    // would land outside the loop and the loop would throw it back.
    if (loopActive(song.player.loop)) {
      useSong.getState().updatePlayer({ loop: { start, end: Math.max(snap(part.end), start + MIN_LOOP), on: true } });
      songPlayer.seek(start);
      toast(L().actions.loop.section(sectionLabel(sections, index, isTabSong(song))));
      return;
    }
    songPlayer.seek(start);
    toast(sectionLabel(sections, index, isTabSong(song)));
  },

  /** Runs the analysis again (the user's chord edits stay). */
  async analyze(songId: string): Promise<void> {
    try {
      const song = await api.analyze(songId);
      useSong.getState().syncFromLibrary(song);
      await refreshLibrary();
      pollSoon();
      toast(L().actions.analysis.again);
    } catch (error) {
      toast(error instanceof Error ? error.message : L().actions.analysis.startFailed, 'warn');
    }
  },

  async exportBacking(): Promise<void> {
    const song = readySong();
    if (!song) return;
    if (isTabSong(song)) {
      toast(L().actions.export.tabSong);
      return;
    }
    const model = song.activeModel;
    if (!model || song.stems[model]?.status !== 'ready') {
      toast(L().actions.export.stemsNotReady, 'warn');
      return;
    }
    toast(L().actions.export.making);
    try {
      // The language names the file the service builds.
      const body = { ...exportBody(song, model, song.player.loop), lang: fileLang() };
      const { blob, fileName } = await api.exportMp3(song.id, body);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      toast(L().actions.export.saved(fileName));
    } catch (error) {
      toast(error instanceof Error ? error.message : L().actions.export.failed, 'warn');
    }
  },

  songVolume(dir: 1 | -1): void {
    const settings = useSettings.getState();
    settings.setSongVolumeDb(settings.songVolumeDb + dir);
  },

  async separate(songId: string, model: ModelId): Promise<void> {
    try {
      const song = await api.separate(songId, model);
      useSong.getState().syncFromLibrary(song);
      await refreshLibrary();
      pollSoon();
      toast(L().actions.mix.separating);
    } catch (error) {
      toast(error instanceof Error ? error.message : L().actions.mix.separateFailed, 'warn');
    }
  },

  async dropStems(songId: string, model: ModelId): Promise<void> {
    try {
      const song = await api.dropStems(songId, model);
      useSong.getState().syncFromLibrary(song);
      await refreshLibrary();
    } catch (error) {
      toast(error instanceof Error ? error.message : L().actions.mix.dropFailed, 'warn');
    }
  },
};

let pendingDelete: { id: string; until: number } | null = null;

/** Delete twice within 4 seconds removes the song — no pop-up dialogs. */
export async function deleteSongTwice(id: string): Promise<void> {
  const song = useLibrary.getState().songs.find((s) => s.id === id);
  if (!song) return;
  const now = Date.now();
  if (!pendingDelete || pendingDelete.id !== id || pendingDelete.until < now) {
    pendingDelete = { id, until: now + 4000 };
    toast(L().actions.song.deleteAgain(song.title), 'warn');
    return;
  }
  pendingDelete = null;
  try {
    if (useSong.getState().song?.id === id) {
      await useSong.getState().closeSong();
      useSettings.getState().setLastSongId(null);
    }
    await api.deleteSong(id);
    await refreshLibrary();
    toast(L().actions.song.deleted(song.title));
  } catch (error) {
    toast(error instanceof Error ? error.message : L().actions.song.deleteFailed, 'warn');
  }
}
