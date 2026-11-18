import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSong, withDefaults } from '../state/song';
import { songActions } from './actions';
import type { Song } from './types';

// The real player needs an AudioContext; these actions only read its position.
vi.mock('./player', () => ({ songPlayer: { position: () => 0, seek: () => undefined, resume: () => undefined } }));

const song = (player: Partial<Song['player']>): Song =>
  withDefaults({
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
    stems: {},
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
      ...player,
    },
  } as Song);

describe('«Снять на слух» hides an open chord correction', () => {
  beforeEach(() => {
    useSong.setState({ song: null, editIndex: null });
  });

  it('Shift+H hides the hints and closes the correction (it shows the chord name)', () => {
    useSong.setState({ song: song({ mode: 'ear', reveal: 3 }), editIndex: 4 });
    songActions.hideHints();
    expect(useSong.getState().song?.player.reveal).toBe(0);
    expect(useSong.getState().editIndex).toBeNull();
  });

  it('H to «Снять на слух» closes it too', () => {
    useSong.setState({ song: song({ mode: 'play' }), editIndex: 2 });
    songActions.toggleMode();
    expect(useSong.getState().song?.player.mode).toBe('ear');
    expect(useSong.getState().editIndex).toBeNull();
  });
});
