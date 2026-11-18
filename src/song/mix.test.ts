import { describe, expect, it } from 'vitest';
import { exportBody, songBusDb, stemGains } from './mix';
import type { PlayerSettings, Song } from './types';

const player = (patch: Partial<PlayerSettings> = {}): PlayerSettings => ({
  speed: 1,
  semitones: 0,
  cents: 0,
  volumesDb: { vocals: 0, drums: 0, bass: 0, guitar: 0, piano: 0, other: 0 },
  muted: ['guitar'],
  solo: null,
  loop: { start: 0, end: 0, on: false },
  view: 'chords',
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
  ...patch,
});

describe('stemGains', () => {
  it('silences muted stems', () => {
    expect(stemGains(player())).toEqual({ vocals: 1, drums: 1, bass: 1, guitar: 0, piano: 1, other: 1 });
  });

  it('solo plays only that stem, even when it is muted', () => {
    expect(stemGains(player({ solo: 'guitar' }))).toEqual({ vocals: 0, drums: 0, bass: 0, guitar: 1, piano: 0, other: 0 });
  });

  it('applies the volume of each stem', () => {
    const gains = stemGains(player({ volumesDb: { vocals: 0, drums: 0, bass: -6, guitar: 0, piano: 0, other: 0 } }));
    expect(gains.bass).toBeCloseTo(0.501, 3);
  });
});

describe('songBusDb', () => {
  it('brings the song to -23 dB and undoes the stems headroom', () => {
    expect(songBusDb(-12, -0.5, 0)).toBeCloseTo(-10.5, 9);
    expect(songBusDb(-14, 0, 3)).toBeCloseTo(-6, 9);
  });

  it('never boosts or cuts by more than 20 dB', () => {
    expect(songBusDb(-70, 0, 0)).toBe(20);
    expect(songBusDb(10, 0, 0)).toBe(-20);
  });
});

describe('exportBody', () => {
  const song = { player: player({ speed: 0.8, semitones: -1, cents: -5 }) } as Song;

  it('takes the loop when it is on, and folds cents into semitones', () => {
    expect(exportBody(song, 'bs_roformer_sw', { start: 10, end: 20, on: true })).toEqual({
      model: 'bs_roformer_sw',
      gains: { vocals: 1, drums: 1, bass: 1, guitar: 0, piano: 1, other: 1 },
      speed: 0.8,
      semitones: -1.05,
      start: 10,
      end: 20,
    });
  });

  it('takes the whole song otherwise', () => {
    expect(exportBody(song, 'htdemucs_6s', { start: 10, end: 20, on: false })).toMatchObject({ start: 0, end: null });
  });
});
