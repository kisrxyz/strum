// How loud each stem and the whole song play.
import { dbToLin } from '../dsp/level';
import { loopActive } from './schedule';
import { STEMS, type ExportBody, type Loop, type ModelId, type PlayerSettings, type Song, type Stem } from './types';

/**
 * The song is brought to this average loudness. The guitar presets give about -21 dB RMS, so the
 * band sits a little under the guitar. Both went 3 dB down on 2026-11-16 (from -20 and -18): the
 * card adds the guitar and the song, and their sum must stay under full scale.
 */
export const SONG_TARGET_DB = -23;
const MAX_NORMALISATION_DB = 20;

/** Linear gain per stem. Solo beats mute: solo on the muted guitar plays the guitar. */
export function stemGains(p: PlayerSettings): Record<Stem, number> {
  const gains = {} as Record<Stem, number>;
  for (const stem of STEMS) {
    const audible = p.solo ? stem === p.solo : !p.muted.includes(stem);
    gains[stem] = audible ? dbToLin(p.volumesDb[stem] ?? 0) : 0;
  }
  return gains;
}

/** Gain of the song bus: normalisation (clamped), undo of the stems' headroom, the user's volume. */
export function songBusDb(loudnessDb: number, stemsGainDb: number, songVolumeDb: number): number {
  const normalise = Math.min(MAX_NORMALISATION_DB, Math.max(-MAX_NORMALISATION_DB, SONG_TARGET_DB - loudnessDb));
  return normalise - stemsGainDb + songVolumeDb;
}

/** What the service needs for a backing track that sounds like the player now. */
export function exportBody(song: Song, model: ModelId, loop: Loop): ExportBody {
  const p = song.player;
  const looped = loopActive(loop);
  return {
    model,
    gains: stemGains(p),
    speed: p.speed,
    semitones: Math.round((p.semitones + p.cents / 100) * 100) / 100,
    start: looped ? loop.start : 0,
    end: looped ? loop.end : null,
  };
}
