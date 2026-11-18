// The library's lists, search, the set-list, the radio and the random song (stage 4, «На веселухе»).
import { L } from '../i18n';
import type { Song, SongList } from './types';

/**
 * What the «Песни» screen shows: every song, one of the song's lists, the set-list (kept in the
 * browser), or the takes («Записи»: the user's own recordings, not songs).
 */
export type LibraryList = 'all' | SongList | 'set' | 'takes';

export const LIST_ORDER: readonly LibraryList[] = ['all', 'favorite', 'learn', 'set', 'takes'];

/** The lists' names, read in the current language each time (getters, not stored texts). */
export const LIST_NAMES: Readonly<Record<LibraryList, string>> = Object.defineProperties(
  {} as Record<LibraryList, string>,
  Object.fromEntries(
    LIST_ORDER.map((list) => [list, { enumerable: true, get: () => L().actions.lists.names[list] }]),
  ),
);

/** Lower case, «ё» as «е», no punctuation: what search compares. */
export function searchKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е') // ё → е (escaped: no Cyrillic in code outside the dictionaries)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The songs of a list that match the search (every word of it, in the title or the artist). The set-list keeps its order. */
export function filterSongs(songs: readonly Song[], list: LibraryList, query: string, setlist: readonly string[]): Song[] {
  let out: Song[];
  if (list === 'takes') return [];
  if (list === 'set') {
    const byId = new Map(songs.map((s) => [s.id, s]));
    out = setlist.map((id) => byId.get(id)).filter((s): s is Song => s !== undefined);
  } else if (list === 'all') out = [...songs];
  else out = songs.filter((s) => (s.lists ?? []).includes(list));
  const words = searchKey(query).split(' ').filter(Boolean);
  if (!words.length) return out;
  return out.filter((s) => {
    const hay = searchKey(`${s.title} ${s.artist}`);
    return words.every((w) => hay.includes(w));
  });
}

/** The song's lists with `list` turned on or off. */
export function toggleList(lists: readonly SongList[], list: SongList): SongList[] {
  return lists.includes(list) ? lists.filter((l) => l !== list) : [...lists, list];
}

/** S: the song added to the end of the set-list, or taken out of it. */
export function toggleInSet(setlist: readonly string[], id: string): string[] {
  return setlist.includes(id) ? setlist.filter((x) => x !== id) : [...setlist, id];
}

/** Shift+↑ / Shift+↓: the song one place earlier or later in the set-list. */
export function moveInSet(setlist: readonly string[], id: string, dir: 1 | -1): string[] {
  const i = setlist.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= setlist.length) return [...setlist];
  const out = [...setlist];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The set-list without songs that are gone from the library. */
export function pruneSet(setlist: readonly string[], existing: readonly string[]): string[] {
  const have = new Set(existing);
  return setlist.filter((id) => have.has(id));
}

/** A set-list or the radio being played: the order of songs and where we are in it. */
export interface Queue {
  kind: 'set' | 'radio';
  ids: string[];
  index: number;
}

/**
 * The index of the song after `queue.index` that is still in the library, −1 at the end of a
 * set-list. The radio goes round: at its end the caller deals a new shuffle (`radioQueue`).
 */
export function nextInQueue(queue: Queue, existing: readonly string[]): number {
  const have = new Set(existing);
  for (let i = queue.index + 1; i < queue.ids.length; i++) {
    if (have.has(queue.ids[i])) return i;
  }
  return -1;
}

/** Fisher–Yates with the given random source (0 ≤ r < 1), so tests can pin it. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** R: the songs in a random order, not starting with the song that just played (when there is a choice). */
export function radioQueue(ids: readonly string[], justPlayed: string | null, random: () => number = Math.random): Queue {
  const order = shuffle(ids, random);
  if (order.length > 1 && order[0] === justPlayed) [order[0], order[1]] = [order[1], order[0]];
  return { kind: 'radio', ids: order, index: 0 };
}

/** Shift+L: a random song other than the open one (when there is another); null without songs. */
export function randomSong(ids: readonly string[], current: string | null, random: () => number = Math.random): string | null {
  const choice = ids.length > 1 ? ids.filter((id) => id !== current) : [...ids];
  if (!choice.length) return null;
  return choice[Math.min(choice.length - 1, Math.floor(random() * choice.length))];
}
