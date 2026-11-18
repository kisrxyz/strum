import { describe, expect, it } from 'vitest';
import {
  filterSongs,
  moveInSet,
  nextInQueue,
  pruneSet,
  radioQueue,
  randomSong,
  searchKey,
  shuffle,
  toggleInSet,
  toggleList,
} from './setlist';
import type { Song } from './types';

const song = (id: string, title: string, artist: string, lists: Song['lists'] = []): Song =>
  ({ id, title, artist, lists }) as Song;

const SONGS = [
  song('a', 'Кайен', 'Звери', ['favorite']),
  song('b', 'Ёлка', 'Би-2', ['learn']),
  song('c', 'Wonderwall', 'Oasis', ['favorite', 'learn']),
];

/** A fixed «random» sequence for the tests. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('search and lists', () => {
  it('compares without case, ё or punctuation', () => {
    expect(searchKey('  Ёлка — Би-2! ')).toBe('елка би 2');
  });

  it('filters by list and by every word of the search', () => {
    const ids = (list: Parameters<typeof filterSongs>[1], q: string, set: string[] = []) =>
      filterSongs(SONGS, list, q, set).map((s) => s.id);
    expect(ids('all', '')).toEqual(['a', 'b', 'c']);
    expect(ids('favorite', '')).toEqual(['a', 'c']);
    expect(ids('learn', '')).toEqual(['b', 'c']);
    expect(ids('all', 'елка')).toEqual(['b']);
    expect(ids('all', 'oasis wonder')).toEqual(['c']);
    expect(ids('all', 'oasis кайен')).toEqual([]);
    expect(ids('set', '', ['c', 'gone', 'a'])).toEqual(['c', 'a']); // the set-list's order
    expect(ids('set', 'зв', ['c', 'a'])).toEqual(['a']);
  });

  it('turns a list on and off', () => {
    expect(toggleList([], 'favorite')).toEqual(['favorite']);
    expect(toggleList(['favorite', 'learn'], 'favorite')).toEqual(['learn']);
  });
});

describe('the set-list', () => {
  it('adds, removes and moves songs', () => {
    expect(toggleInSet(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleInSet(['a', 'b'], 'a')).toEqual(['b']);
    expect(moveInSet(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveInSet(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveInSet(['a', 'b', 'c'], 'x', 1)).toEqual(['a', 'b', 'c']);
    expect(pruneSet(['a', 'x', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('plays on to the next song that still exists and stops at the end', () => {
    const queue = { kind: 'set' as const, ids: ['a', 'b', 'c'], index: 0 };
    expect(nextInQueue(queue, ['a', 'b', 'c'])).toBe(1);
    expect(nextInQueue(queue, ['a', 'c'])).toBe(2); // b was deleted while a played
    expect(nextInQueue({ ...queue, index: 2 }, ['a', 'b', 'c'])).toBe(-1);
    expect(nextInQueue(queue, ['a'])).toBe(-1);
  });
});

describe('random songs', () => {
  it('shuffles with the given random source', () => {
    expect(shuffle(['a', 'b', 'c'], seq(0))).toEqual(['b', 'c', 'a']);
    expect([...shuffle(['a', 'b', 'c', 'd'])].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not start the radio with the song that just played', () => {
    const queue = radioQueue(['a', 'b', 'c'], 'b', seq(0));
    expect(queue.ids[0]).not.toBe('b');
    expect([...queue.ids].sort()).toEqual(['a', 'b', 'c']);
    expect(radioQueue(['a'], 'a').ids).toEqual(['a']);
  });

  it('picks another song than the open one', () => {
    expect(randomSong(['a', 'b'], 'a', seq(0))).toBe('b');
    expect(randomSong(['a', 'b', 'c'], 'c', seq(0.99))).toBe('b');
    expect(randomSong(['a'], 'a')).toBe('a');
    expect(randomSong([], null)).toBeNull();
  });
});
