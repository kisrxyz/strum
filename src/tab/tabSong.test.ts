import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { importer, Settings, type model } from '@coderline/alphatab/core';
import { describe, expect, it } from 'vitest';
import { looksLikeCyrillicMojibake, readScore } from './load';
import { keepChannels, renderMix, renderStems } from './render';
import { isSoundFont, loudnessDb, peaksInt8, stemsLoudnessDb } from './tabAudio';
import {
  beatTicks,
  keyFromNotes,
  partNotes,
  pickPart,
  scoreChords,
  scoreMidi,
  scoreSections,
  sectionKind,
  stemPlan,
  tabAnalysis,
  tabSongFacts,
  timeline,
  trackStem,
} from './tabSong';

const tex = (text: string): model.Score => importer.ScoreLoader.loadAlphaTex(text, new Settings());

/** Three parts: a guitar with a chord name, a section and a tie; a bass; drums. 100 BPM, 2 bars. */
const BAND = String.raw`\title "Song" \artist "Band" \tempo 100
\track "Lead" \instrument 27
\staff {tabs}
:4 0.6 2.5 {ch "Am"} 2.4 1.3 | \section "Куплет" 0.6.2 -.6.4 3.5.4 |
\track "Bass" \instrument 33
\staff {tabs} \tuning E1 A1 D2 G2
:4 0.4 0.4 0.4 0.4 | 0.4 0.4 0.4 0.4 |
\track "Drums" \instrument percussion
\staff {score}
\articulation defaults
:4 (KickHit) (SnareHit) (KickHit) (SnareHit) | (KickHit) (SnareHit) (KickHit) (SnareHit) |`;

describe('readScore', () => {
  it('tells Russian texts read in the wrong code page', () => {
    expect(looksLikeCyrillicMojibake(['Íåáî', 'Äîðîæêà 1'])).toBe(true);
    // One Russian title among English part names («ssshhhiiittt! — Небо.gp5»).
    expect(looksLikeCyrillicMojibake(['Íåáî', 'ssshhhiiittt!', 'Solo', 'Bass', 'Solo-Rhytm', 'Rhytm', 'Drum'])).toBe(true);
    expect(looksLikeCyrillicMojibake(['Небо', 'Дорожка 1'])).toBe(false);
    expect(looksLikeCyrillicMojibake(['Café del Mar', 'Track 1', 'Über'])).toBe(false);
    expect(looksLikeCyrillicMojibake(['', 'Steel Guitar'])).toBe(false);
  });

  it('reads alphaTex', () => {
    const score = readScore(new TextEncoder().encode(BAND), 'alphatex');
    expect(score.title).toBe('Song');
    expect(score.tracks).toHaveLength(3);
  });
});

describe('parts and stems', () => {
  it('puts each part in its stem and the shown part in «guitar»', () => {
    const score = tex(BAND);
    expect(score.tracks.map(trackStem)).toEqual(['other', 'bass', 'drums']);
    expect(pickPart(score)).toBe(0);
    expect(stemPlan(score, 0)).toEqual({ vocals: [], drums: [9], bass: [2, 3], guitar: [0, 1], piano: [], other: [] });
    // The bass on screen: it is «guitar» now, the lead goes to «other».
    expect(stemPlan(score, 1)).toEqual({ vocals: [], drums: [9], bass: [], guitar: [2, 3], piano: [], other: [0, 1] });
  });

  it('knows a bass by its strings or name and keys by their sound', () => {
    // alphaTex writes only stringed parts as tabs: piano and voice get their sound afterwards.
    const part = (name: string, tuning = '') =>
      `\\track "${name}" \\instrument 27\n\\staff {tabs}${tuning ? ` \\tuning ${tuning}` : ''}\n:4 0.4 0.4 0.4 0.4 |\n`;
    const score = tex(part('Spur 2', 'E1 A1 D2 G2') + part('Grand') + part('Bass guitar') + part('Melody') + part('Rhythm'));
    [26, 0, 27, 53, 29].forEach((program, i) => (score.tracks[i].playbackInfo.program = program));
    expect(score.tracks.map(trackStem)).toEqual(['bass', 'piano', 'bass', 'vocals', 'other']);
    // The first guitar that is not a bass.
    expect(pickPart(score)).toBe(4);
  });

  it('starts on the guitar that plays through the song, not one with a few notes', () => {
    const rest = ':4 r r r r';
    const score = tex(String.raw`\track "Clean" \instrument 27
\staff {tabs}
:4 0.6 0.6 0.6 0.6 | ${rest} | ${rest} | ${rest} |
\track "Main" \instrument 29
\staff {tabs}
:4 0.6 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6 |
\track "Solo" \instrument 30
\staff {tabs}
${rest} | ${rest} | 5.1 5.1 5.1 5.1 | 7.1 7.1 7.1 7.1 |`);
    expect(pickPart(score)).toBe(1);
  });
});

describe('timeline', () => {
  it('unrolls repeats and counts beats in seconds', () => {
    const score = tex(String.raw`\tempo 90 . :4 0.6 0.6 0.6 0.6 | \ro 3.6 3.6 3.6 3.6 | \rc 2 5.6 5.6 5.6 5.6 | 7.6 7.6 7.6 7.6`);
    const line = timeline(score);
    expect(line.bars.map((b) => b.index)).toEqual([0, 1, 2, 1, 2, 3]);
    const bar = (4 * 60) / 90;
    expect(line.bars[3].start).toBeCloseTo(3 * bar);
    expect(line.bars[3].beats).toHaveLength(4);
    expect(line.bars[3].beats[1] - line.bars[3].beats[0]).toBeCloseTo(60 / 90);
    expect(line.end).toBeCloseTo(6 * bar);
  });

  it('follows a tempo change', () => {
    const line = timeline(tex(String.raw`\tempo 120 . :4 0.6 0.6 0.6 0.6 | \tempo 60 0.6 0.6 0.6 0.6`));
    expect(line.bars.map((b) => [b.start, b.end])).toEqual([
      [0, 2],
      [2, 6],
    ]);
    expect(line.bars[1].beats).toEqual([2, 3, 4, 5]);
  });

  it('counts 6/8 in dotted quarters', () => {
    expect(beatTicks(4, 4)).toBe(960);
    expect(beatTicks(6, 8)).toBe(1440);
    expect(beatTicks(7, 8)).toBe(480);
    expect(beatTicks(3, 8)).toBe(480);
    const analysis = tabAnalysis(tex(String.raw`\tempo 120 \ts 6 8 :8 0.6 0.6 0.6 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6 0.6 0.6`), 0);
    expect(analysis.meter).toBe(2);
    expect(analysis.beats).toEqual([0, 0.75, 1.5, 2.25]);
    expect(analysis.tempo).toBe(80);
  });
});

describe('what the score says', () => {
  it('makes the analysis: beats, sections, chords, notes, key', () => {
    const score = tex(BAND);
    const analysis = tabAnalysis(score, 0);
    expect(analysis.source).toBe('tab');
    expect(analysis.tempo).toBe(100);
    expect(analysis.meter).toBe(4);
    expect(analysis.beats).toEqual([0, 0.6, 1.2, 1.8, 2.4, 3, 3.6, 4.2]);
    expect(analysis.downbeats).toEqual([0, 2.4]);
    expect(analysis.sections).toEqual([{ start: 2.4, end: 4.8, kind: 'verse', name: 'Куплет' }]);
    // «Am» on the second beat holds to the end (fewer than four bars).
    expect(analysis.chords).toEqual([{ start: 0.6, end: 4.8, chord: 'A:min' }]);
    // The half note tied to a quarter is one note of three beats.
    expect(analysis.notes?.slice(4)).toEqual([
      { start: 2.4, end: 4.2, midi: 40 },
      { start: 4.2, end: 4.8, midi: 48 },
    ]);
    expect(analysis.notes).toHaveLength(6);
    expect(analysis.tuningCents).toBe(0);
    expect(analysis.tone).toBeNull();
  });

  it('names the sections it knows', () => {
    expect(sectionKind('Вступление')).toBe('intro');
    expect(sectionKind('2й - Куплет')).toBe('verse');
    expect(sectionKind('Предприпев')).toBe('verse');
    expect(sectionKind('Припев')).toBe('chorus');
    expect(sectionKind('Соло 1')).toBe('solo');
    expect(sectionKind('Проигрыш')).toBe('other');
    expect(sectionKind('Кода')).toBe('outro');
  });

  it('numbers a section name used twice and keeps a chord at most four bars', () => {
    const score = tex(String.raw`\tempo 60 . :1 0.6 {ch "C"} | \section "Припев" 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | \section "Припев" 0.6 {ch "G7"} |`);
    const line = timeline(score);
    expect(scoreSections(score, line).map((s) => [s.name, s.start, s.end])).toEqual([
      ['Припев 1', 4, 24],
      ['Припев 2', 24, 28],
    ]);
    expect(scoreChords(score, line)).toEqual([
      { start: 0, end: 16, chord: 'C' },
      { start: 24, end: 28, chord: 'G:7' },
    ]);
  });

  it('reads the notes of a part with a capo at their real pitch', () => {
    const score = tex(String.raw`\track "G" \staff {tabs} \capo 4 :4 2.3 2.3 2.3 2.3`);
    expect(partNotes(score, 0, timeline(score))[0].midi).toBe(61);
    expect(tabSongFacts(score).capo).toBe(4);
  });

  it('finds the key from the notes', () => {
    const am = [57, 60, 64, 57, 60, 64, 62, 65, 69, 64, 68, 71].map((midi, i) => ({ start: i, end: i + 1, midi }));
    expect(keyFromNotes(am)).toMatchObject({ tonic: 9, mode: 'minor' });
    const c = [60, 64, 67, 65, 69, 72, 67, 71, 74, 60, 64, 67].map((midi, i) => ({ start: i, end: i + 1, midi }));
    expect(keyFromNotes(c)).toMatchObject({ tonic: 0, mode: 'major' });
    expect(keyFromNotes([])).toBeNull();
  });

  it('gives the facts the service keeps', () => {
    const facts = tabSongFacts(tex(BAND));
    expect(facts).toEqual({
      title: 'Song',
      artist: 'Band',
      tempo: 100,
      meter: 4,
      track: 0,
      capo: 0,
      trackNames: ['Lead', 'Bass', 'Drums'],
      end: 4.8,
    });
  });
});

describe('render', () => {
  const require = createRequire(import.meta.url);
  const soundFont = new Uint8Array(readFileSync(require.resolve('@coderline/alphatab/soundfont/sonivox.sf2')));
  // 44.1 kHz or more: at 22.05 kHz the synthesizer's filter goes unstable (NaN, replaced by silence).
  const RATE = 44100;

  const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

  it('keeps only the wanted channels in the MIDI', () => {
    const made = scoreMidi(tex(BAND));
    const notes = (m: typeof made.midiFile) => m.tracks.flatMap((t) => t.events).filter((e) => e.type === 128).length;
    const all = notes(made.midiFile);
    keepChannels(made.midiFile, new Set([9]));
    expect(notes(made.midiFile)).toBe(8);
    expect(all).toBeGreaterThan(8);
  });

  it('renders the stems so that they add up to the whole song', () => {
    const score = tex(BAND);
    const mix = renderMix(score, RATE, soundFont);
    const frames = Math.round(4.8 * RATE);
    expect(mix.left.length).toBeGreaterThanOrEqual(frames - RATE * 0.05);
    const stems = renderStems(score, stemPlan(score, 0), RATE, frames, soundFont);
    expect(stems).toHaveLength(12);
    expect(stems.every((c) => c.length === frames)).toBe(true);
    // vocals, piano, other: nothing plays there
    for (const i of [0, 1, 8, 9, 10, 11]) expect(rms(stems[i])).toBe(0);
    // drums, bass, guitar: all sound
    for (const i of [2, 4, 6]) expect(rms(stems[i])).toBeGreaterThan(0.001);
    const sum = new Float32Array(frames);
    for (let k = 0; k < frames; k++) sum[k] = stems[2][k] + stems[4][k] + stems[6][k];
    const diff = new Float32Array(frames);
    for (let k = 0; k < Math.min(frames, mix.left.length); k++) diff[k] = sum[k] - mix.left[k];
    expect(rms(diff)).toBeLessThan(rms(sum) * 0.01);
  });

  it('measures loudness and peaks like the service', () => {
    const rate = 1000;
    const tone = new Float32Array(rate * 4).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 50 * i) / rate));
    // A sine of amplitude 0.4: mean square 0.08 → −10.97 dB.
    expect(loudnessDb(tone, tone, rate)).toBeCloseTo(-10.97, 1);
    expect(loudnessDb(new Float32Array(rate), new Float32Array(rate), rate)).toBe(-70);
    const peaks = peaksInt8(tone, tone, rate, 100);
    expect(peaks).toHaveLength(800);
    expect(Math.max(...peaks)).toBe(51);
    expect(Math.min(...peaks)).toBe(-51);
  });

  it('measures the loudness of the stems as of the song they add up to', () => {
    // The level of a tab-song comes from its render: whatever sounds it was made with.
    const score = tex(BAND);
    const frames = Math.round(4.8 * RATE);
    const stems = renderStems(score, stemPlan(score, 0), RATE, frames, soundFont);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let c = 0; c < stems.length; c += 2) {
      for (let k = 0; k < frames; k++) {
        left[k] += stems[c][k];
        right[k] += stems[c + 1][k];
      }
    }
    expect(stemsLoudnessDb(stems, RATE)).toBeCloseTo(loudnessDb(left, right, RATE), 6);
    expect(stemsLoudnessDb(stems, RATE)).toBeGreaterThan(-40);
  });

  it('tells a soundfont from the page a missing file comes back as', () => {
    expect(isSoundFont(soundFont)).toBe(true);
    expect(isSoundFont(new TextEncoder().encode('<!doctype html><html lang="ru">'))).toBe(false);
    expect(isSoundFont(new Uint8Array(0))).toBe(false);
  });
});
