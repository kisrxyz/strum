// What the stage-4 keys and buttons do: the solo tools (phrases and note edits in «Ноты»,
// «Повтори за мной», «Разгон») and the fun ones (lists and search on «Песни», the set-list, the
// radio, a random song).
import { L } from '../i18n';
import { noteName } from '../music/chords';
import { shapePitchClass, shapeSpelling } from '../music/display';
import { editNote, effectiveNotes, phraseLoop, phrases, stepPhrase, type NoteEdit } from '../music/notes';
import { useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { api } from './api';
import { viewOptions } from './chordView';
import { fmtTime } from './format';
import { songPlayer } from './player';
import { MIN_LOOP, SPEED_MAX, loopActive } from './schedule';
import {
  LIST_ORDER,
  filterSongs,
  moveInSet,
  nextInQueue,
  radioQueue,
  randomSong,
  toggleInSet,
  toggleList,
  type LibraryList,
  type Queue,
} from './setlist';
import { notesMissing } from './textActions';
import type { Song, SongList } from './types';

const toast = (text: string, tone: 'info' | 'warn' = 'info') => useRuntime.getState().showToast(text, tone);
const pct = (speed: number) => L().common.units.pct(Math.round(speed * 100));
/** «Разгон» starts here when the song plays at full speed. */
export const TRAINER_START = 0.7;
/** A set-list or the radio waits this long between songs, ms. */
export const QUEUE_GAP_MS = 3000;

/** The songs the «Песни» screen shows now: its list, then the search. */
export function visibleSongs(): Song[] {
  const { songs } = useLibrary.getState();
  const { libraryList, search } = useRuntime.getState();
  return filterSongs(songs, libraryList, search, useSettings.getState().setlist);
}

/** Keeps the highlighted song among the visible ones. */
function keepSelection(): void {
  const visible = visibleSongs();
  const { selectedId, patch } = useLibrary.getState();
  if (!visible.some((s) => s.id === selectedId)) patch({ selectedId: visible[0]?.id ?? null });
}

const songTitle = (song: Pick<Song, 'title' | 'artist'>) => L().actions.song.title(song.title, song.artist);

/** The open, loaded song with an active loop, or null with a word to the user. */
function loopSong(): Song | null {
  const { song, state } = useSong.getState();
  if (!song || state !== 'ready') {
    toast(song ? L().actions.song.loading : L().actions.song.openFirst);
    return null;
  }
  if (!loopActive(song.player.loop)) {
    toast(L().actions.loop.needLoop);
    return null;
  }
  return song;
}

/** The queue's song openings run one after another; a newer one (End pressed again) wins. */
let opening: Promise<unknown> = Promise.resolve();
let openToken = 0;
let openingNow = 0;

/** True while the set-list or the radio is opening its next song (it is not «another song by hand»). */
export const queueOpening = () => openingNow > 0;

/** Opens a song, shows «Песня» and starts it from the beginning once it is loaded. */
async function openAndPlay(id: string): Promise<boolean> {
  const token = ++openToken;
  openingNow++;
  try {
    await opening.catch(() => undefined);
    if (token !== openToken) return false;
    const run = loadAndPlay(id, token);
    opening = run;
    return await run;
  } finally {
    openingNow--;
  }
}

async function loadAndPlay(id: string, token: number): Promise<boolean> {
  try {
    await useSong.getState().openSong(id);
  } catch (error) {
    toast(error instanceof Error ? error.message : L().actions.song.openFailed, 'warn');
    return false;
  }
  if (token !== openToken) return false;
  useRuntime.getState().patch({ view: 'song' });
  const ready = await new Promise<boolean>((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => done(false), 120_000);
    function done(ok: boolean) {
      off();
      clearTimeout(timer);
      resolve(ok);
    }
    const check = (s: ReturnType<typeof useSong.getState>) => {
      if (s.song?.id !== id || s.state === 'error') done(false);
      else if (s.state === 'ready') done(true);
    };
    off = useSong.subscribe(check);
    check(useSong.getState());
  });
  const store = useSong.getState();
  if (!ready || !store.song || token !== openToken) return false;
  // A loop would keep the song from ending: the set-list and the radio play songs whole.
  if (store.song.player.loop.on) store.updatePlayer({ loop: { ...store.song.player.loop, on: false } });
  songPlayer.seek(0);
  store.patch({ playing: true });
  return true;
}

let gapTimer: ReturnType<typeof setTimeout> | null = null;

function clearGap(): void {
  if (gapTimer) clearTimeout(gapTimer);
  gapTimer = null;
}

/** The queue's next song now (End, or 3 s after a song ended). */
async function advance(): Promise<void> {
  clearGap();
  const rt = useRuntime.getState();
  const queue = rt.queue;
  if (!queue) return;
  const existing = useLibrary.getState().songs.map((s) => s.id);
  let next: Queue = queue;
  let index = nextInQueue(queue, existing);
  if (index < 0) {
    if (queue.kind === 'set') {
      rt.patch({ queue: null });
      toast(L().actions.lists.setDone);
      return;
    }
    // The radio goes round: the same songs, dealt again.
    const have = new Set(existing);
    next = radioQueue(queue.ids.filter((id) => have.has(id)), queue.ids[queue.index] ?? null);
    index = 0;
    if (!next.ids.length) {
      rt.patch({ queue: null });
      return;
    }
  }
  const moved = { ...next, index };
  rt.patch({ queue: moved });
  await openAndPlay(moved.ids[index]);
}

export const funActions = {
  // ---- solos

  /** Shift+R: «Повтори за мной» on / off. */
  toggleRepeat(): void {
    const rt = useRuntime.getState();
    if (rt.repeat) {
      rt.patch({ repeat: false });
      toast(L().actions.practice.repeatOff);
      return;
    }
    const song = loopSong();
    if (!song) return;
    const source = useSong.getState().source;
    if (!source || source === 'mix') {
      toast(L().actions.mix.stemsNeeded);
      return;
    }
    rt.patch({ repeat: true });
    toast(L().actions.practice.repeatOn);
  },

  /** Shift+=: «Разгон» on / off. */
  toggleSpeedTrainer(): void {
    const rt = useRuntime.getState();
    if (rt.speedTrainer) {
      rt.patch({ speedTrainer: false });
      toast(L().actions.practice.trainerOff);
      return;
    }
    const song = loopSong();
    if (!song) return;
    let speed = song.player.speed;
    if (speed >= SPEED_MAX) {
      speed = TRAINER_START;
      useSong.getState().updatePlayer({ speed });
    }
    rt.patch({ speedTrainer: true });
    toast(L().actions.practice.trainerOn(pct(speed), `+${pct(0.05)}`));
  },

  /** Q in «Ноты»: loop the phrase the song is in (or the next one), on the beats. */
  loopPhrase(): void {
    const { song, analysis, state } = useSong.getState();
    if (!song || state !== 'ready') return void toast(song ? L().actions.song.loading : L().actions.song.openFirst);
    const list = phrases(effectiveNotes(song, analysis));
    if (!list.length) return void toast(notesMissing(song));
    const pos = songPlayer.position();
    let index = list.findIndex((p) => p.end > pos);
    if (index < 0) index = list.length - 1;
    const loop = phraseLoop(list[index], analysis?.beats ?? []);
    const end = Math.min(song.duration, Math.max(loop.end, loop.start + MIN_LOOP));
    useSong.getState().updatePlayer({ loop: { start: loop.start, end, on: true } });
    songPlayer.seek(loop.start);
    toast(L().actions.loop.phrase(index + 1, list.length, `${fmtTime(loop.start)}–${fmtTime(end)}`));
  },

  /** Shift+← / Shift+→ in «Ноты»: the previous or the next phrase (with a loop on, the loop moves there). */
  stepPhrase(dir: 1 | -1): void {
    const { song, analysis, state } = useSong.getState();
    if (!song || state !== 'ready') return;
    const list = phrases(effectiveNotes(song, analysis));
    if (!list.length) return void toast(notesMissing(song));
    const index = stepPhrase(list, songPlayer.position(), dir);
    if (index < 0) return;
    if (loopActive(song.player.loop)) {
      const loop = phraseLoop(list[index], analysis?.beats ?? []);
      const end = Math.min(song.duration, Math.max(loop.end, loop.start + MIN_LOOP));
      useSong.getState().updatePlayer({ loop: { start: loop.start, end, on: true } });
      songPlayer.seek(loop.start);
    } else songPlayer.seek(Math.max(0, list[index].start - 0.3));
    toast(L().actions.loop.phraseAt(index + 1, list.length));
  },

  /** A click on a note of the lane: its editor opens in the fretboard's place (null closes it). */
  openNoteEditor(index: number | null): void {
    useRuntime.getState().patch({ noteEdit: index });
  },

  /** The editor's buttons: a semitone down or up, or remove the note. */
  editNote(index: number, edit: NoteEdit): void {
    const { song, analysis } = useSong.getState();
    if (!song) return;
    const notes = effectiveNotes(song, analysis);
    const note = notes[index];
    if (!note) return;
    useSong.getState().updateSong({ guitarNotes: editNote(notes, index, edit) });
    if (edit === 'remove') {
      useRuntime.getState().patch({ noteEdit: null });
      return;
    }
    const o = viewOptions(song);
    const midi = note.midi + (edit === 'up' ? 1 : -1) + song.player.semitones;
    toast(L().actions.notes.note(noteName(shapePitchClass(midi, o), shapeSpelling(analysis?.key ?? null, o))));
  },

  /** «Как услышал сервис»: the user's note edits are dropped. */
  resetNotes(): void {
    useSong.getState().updateSong({ guitarNotes: null });
    useRuntime.getState().patch({ noteEdit: null });
    toast(L().actions.notes.reset);
  },

  // ---- «Песни»: lists and search

  setLibraryList(list: LibraryList): void {
    useRuntime.getState().patch({ libraryList: list });
    keepSelection();
  },

  /** ← / → on «Песни»: the next list. */
  stepLibraryList(dir: 1 | -1): void {
    const current = LIST_ORDER.indexOf(useRuntime.getState().libraryList);
    funActions.setLibraryList(LIST_ORDER[(current + dir + LIST_ORDER.length) % LIST_ORDER.length]);
  },

  setSearch(text: string): void {
    useRuntime.getState().patch({ search: text });
    keepSelection();
  },

  /** «/»: to the search field. */
  focusSearch(): void {
    document.querySelector<HTMLInputElement>('.library__search')?.focus();
  },

  /** F / W on «Песни»: the highlighted song into «Избранное» / «Хочу выучить» or out of it. */
  toggleSongList(list: SongList): void {
    const { songs, selectedId } = useLibrary.getState();
    const song = songs.find((s) => s.id === selectedId);
    if (!song) return;
    const lists = toggleList(song.lists ?? [], list);
    useLibrary.setState({ songs: songs.map((s) => (s.id === song.id ? { ...s, lists } : s)) });
    const open = useSong.getState().song;
    if (open?.id === song.id) useSong.getState().updateSong({ lists });
    else void api.patchSong(song.id, { lists }).catch(() => toast(L().actions.lists.notSaved, 'warn'));
    const t = L().actions.lists;
    const added = lists.includes(list);
    if (list === 'favorite') toast(added ? t.favoriteAdded(songTitle(song)) : t.favoriteRemoved(songTitle(song)));
    else toast(added ? t.learnAdded(songTitle(song)) : t.learnRemoved(songTitle(song)));
    keepSelection();
  },

  /** S on «Песни»: the highlighted song to the end of the set-list, or out of it. */
  toggleSet(): void {
    const { songs, selectedId } = useLibrary.getState();
    const song = songs.find((s) => s.id === selectedId);
    if (!song) return;
    const st = useSettings.getState();
    const setlist = toggleInSet(st.setlist, song.id);
    st.setSetlist(setlist);
    toast(setlist.includes(song.id) ? L().actions.lists.setAdded(songTitle(song), setlist.length) : L().actions.lists.setRemoved(songTitle(song)));
    keepSelection();
  },

  /** Shift+↑ / Shift+↓ in «Сет-лист»: the highlighted song one place earlier or later. */
  moveInSet(dir: 1 | -1): void {
    if (useRuntime.getState().libraryList !== 'set') {
      toast(L().actions.lists.orderOnlyInSet);
      return;
    }
    const id = useLibrary.getState().selectedId;
    if (!id) return;
    const st = useSettings.getState();
    st.setSetlist(moveInSet(st.setlist, id, dir));
  },

  // ---- the set-list, the radio, a random song

  /** Enter in «Сет-лист»: play it in order from the highlighted song. */
  playSet(): void {
    const ids = filterSongs(useLibrary.getState().songs, 'set', '', useSettings.getState().setlist).map((s) => s.id);
    if (!ids.length) {
      toast(L().actions.lists.setEmpty);
      return;
    }
    const selected = useLibrary.getState().selectedId;
    const index = Math.max(0, ids.indexOf(selected ?? ''));
    clearGap();
    useRuntime.getState().patch({ queue: { kind: 'set', ids, index } });
    toast(L().actions.lists.setPlaying(index + 1, ids.length));
    void openAndPlay(ids[index]);
  },

  /** R on «Песни»: the shown list (or the whole library) round and round, shuffled. */
  radio(): void {
    const ids = visibleSongs().map((s) => s.id);
    if (!ids.length) {
      toast(L().actions.lists.listEmpty);
      return;
    }
    clearGap();
    const queue = radioQueue(ids, useSong.getState().song?.id ?? null);
    useRuntime.getState().patch({ queue });
    toast(L().actions.lists.radio);
    void openAndPlay(queue.ids[0]);
  },

  /** End: the set-list's or the radio's next song now. */
  next(): void {
    if (!useRuntime.getState().queue) {
      toast(L().actions.lists.nothingQueued);
      return;
    }
    void advance();
  },

  /** Esc (or a pause on the radio): the set-list or the radio stops; the song stays open. */
  stopQueue(): void {
    clearGap();
    const queue = useRuntime.getState().queue;
    if (!queue) return;
    useRuntime.getState().patch({ queue: null });
    toast(queue.kind === 'radio' ? L().actions.lists.radioOff : L().actions.lists.setStopped);
  },

  /** A song of the queue ended by itself: the next one in 3 s. */
  songEnded(): void {
    const queue = useRuntime.getState().queue;
    if (!queue) return;
    const existing = useLibrary.getState().songs;
    const index = nextInQueue(queue, existing.map((s) => s.id));
    const next = existing.find((s) => s.id === queue.ids[index]);
    if (queue.kind === 'set' && !next) {
      useRuntime.getState().patch({ queue: null });
      toast(L().actions.lists.setDone);
      return;
    }
    if (next) toast(L().actions.lists.next(songTitle(next)));
    clearGap();
    gapTimer = setTimeout(() => {
      gapTimer = null;
      // Something else was started meanwhile: the queue waits for it to end.
      if (useSong.getState().playing || useRuntime.getState().queue !== queue) return;
      void advance();
    }, QUEUE_GAP_MS);
  },

  /** Shift+L: a random song from the shown list (or the whole library). */
  randomSong(): void {
    const ids = visibleSongs().map((s) => s.id);
    const id = randomSong(ids, useSong.getState().song?.id ?? null);
    if (!id) {
      toast(L().actions.lists.noSongs);
      return;
    }
    const song = useLibrary.getState().songs.find((s) => s.id === id);
    useLibrary.getState().patch({ selectedId: id });
    void useSong
      .getState()
      .openSong(id)
      .then(() => {
        useRuntime.getState().patch({ view: 'song' });
        if (song) toast(L().actions.lists.random(songTitle(song)));
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : L().actions.song.openFailed, 'warn'));
  },
};
