// A tab played by the app itself («песня из таба»): what the score says about the song, read once
// from alphaTab's model and the MIDI it generates — the parts and which stem each one plays in,
// the beats and bars, the sections, the chords written in the file, the key and the notes of the
// part on screen. The synthesizer renders the same MIDI, so all of this lines up with the audio
// exactly. Core-only alphaTab import: this runs in the tab-song worker too.
import { midi, Settings, type model } from '@coderline/alphatab/core';
import { chordLabel, chordTones, parseChord, pitchClass } from '../music/chords';
import { parseChordText } from '../music/chordText';
import { STEMS, type Analysis, type ChordSegment, type GuitarNote, type Section, type SectionKind, type Stem } from '../song/types';

/** Ticks per quarter note in alphaTab's MIDI. */
export const TICKS_PER_QUARTER = 960;
/** analysis.version of a tab-song's analysis (its own numbering: the service never makes it). */
export const TAB_ANALYSIS_VERSION = 1;
/** A chord written in the file holds until the next one, but not longer than this many bars. */
const CHORD_HOLD_BARS = 4;

// General MIDI programs.
const isGuitarProgram = (p: number) => p >= 24 && p <= 31;
const isBassProgram = (p: number) => p >= 32 && p <= 39;
const isKeysProgram = (p: number) => p >= 0 && p <= 23;
const isVoiceProgram = (p: number) => p >= 52 && p <= 54;

const BASS_NAME = /bass|бас/i;
const VOICE_NAME = /vocal|voice|vox|вокал|голос/i;
const KEYS_NAME = /piano|keys|organ|клавиш|пиан|орган|рояль/i;

export interface MidiOfScore {
  midiFile: midi.MidiFile;
  generator: midi.MidiFileGenerator;
}

/** The score's MIDI as alphaTab plays it (transposition pitches left to the synthesizer, as alphaTab's own export does). */
export function scoreMidi(score: model.Score): MidiOfScore {
  const midiFile = new midi.MidiFile();
  const generator = new midi.MidiFileGenerator(score, new Settings(), new midi.AlphaSynthMidiFileHandler(midiFile));
  generator.applyTranspositionPitches = false;
  generator.generate();
  return { midiFile, generator };
}

const isPercussion = (track: model.Track) => track.staves.some((s) => s.isPercussion) || track.playbackInfo.primaryChannel === 9;

function noteCount(track: model.Track): number {
  let count = 0;
  for (const staff of track.staves)
    for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) count += beat.notes.length;
  return count;
}

/** How many bars of the score the part plays in. */
function barsPlayed(track: model.Track): number {
  const bars = new Set<number>();
  for (const staff of track.staves) {
    for (const bar of staff.bars) {
      if (bar.voices.some((voice) => voice.beats.some((beat) => beat.notes.length > 0))) bars.add(bar.index);
    }
  }
  return bars.size;
}

/** Which stem a part plays in when it is not the part on screen. */
export function trackStem(track: model.Track): Stem {
  if (isPercussion(track)) return 'drums';
  const program = track.playbackInfo.program;
  const strings = track.staves[0]?.tuning.length ?? 0;
  // A bass written with a guitar's sound or as a 4–5 string part is still the bass.
  if (isBassProgram(program) || BASS_NAME.test(track.name) || strings === 4 || strings === 5) return 'bass';
  if (isVoiceProgram(program) || VOICE_NAME.test(track.name)) return 'vocals';
  if (isKeysProgram(program) || KEYS_NAME.test(track.name)) return 'piano';
  return 'other';
}

/**
 * The part shown first: the first guitar that plays through most of the song (in at least half as
 * many bars as the busiest guitar: a part that only has the solo, or a few clean notes, is
 * skipped); without guitars, the first part with notes that is not the drums.
 */
export function pickPart(score: model.Score): number {
  const tracks = score.tracks;
  const guitars = tracks
    .map((t, i) => ({ i, bars: barsPlayed(t), guitar: !isPercussion(t) && isGuitarProgram(t.playbackInfo.program) && trackStem(t) === 'other' }))
    .filter((g) => g.guitar && g.bars > 0);
  const most = Math.max(0, ...guitars.map((g) => g.bars));
  const main = guitars.find((g) => g.bars >= most / 2);
  if (main) return main.i;
  const pitched = tracks.findIndex((t) => noteCount(t) > 0 && !isPercussion(t));
  return Math.max(0, pitched);
}

/** The MIDI channels each stem renders. The part on screen is the «guitar» stem. */
export type StemPlan = Record<Stem, number[]>;

export function stemPlan(score: model.Score, part: number): StemPlan {
  const plan = Object.fromEntries(STEMS.map((stem) => [stem, [] as number[]])) as StemPlan;
  const owner = new Map<number, Stem>();
  const claim = (track: model.Track, stem: Stem) => {
    for (const channel of [track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel]) {
      // A channel two parts share (all drum parts are on 9) stays with the first that took it:
      // the part on screen goes first.
      if (owner.has(channel)) continue;
      owner.set(channel, stem);
      plan[stem].push(channel);
    }
  };
  const shown = score.tracks[part];
  if (shown) claim(shown, 'guitar');
  score.tracks.forEach((track, i) => {
    if (i !== part) claim(track, trackStem(track));
  });
  return plan;
}

// ---- time

interface TempoPoint {
  tick: number;
  bpm: number;
  /** Seconds at `tick`. */
  at: number;
}

/** Ticks → seconds by the MIDI's tempo events: the very clock the synthesizer plays by. */
export class TempoMap {
  private readonly points: TempoPoint[];

  constructor(midiFile: midi.MidiFile, startBpm: number) {
    const events: { tick: number; bpm: number }[] = [];
    const lists = midiFile.tracks.length ? midiFile.tracks.map((t) => t.events) : [midiFile.events];
    for (const list of lists) {
      for (const e of list) {
        if (e.type === midi.MidiEventType.TempoChange) events.push({ tick: e.tick, bpm: (e as midi.TempoChangeEvent).beatsPerMinute });
      }
    }
    events.sort((a, b) => a.tick - b.tick);
    const points: TempoPoint[] = [{ tick: 0, bpm: startBpm > 0 ? startBpm : 120, at: 0 }];
    for (const e of events) {
      if (!(e.bpm > 0)) continue;
      const last = points[points.length - 1];
      const at = last.at + ((e.tick - last.tick) / TICKS_PER_QUARTER) * (60 / last.bpm);
      if (e.tick === last.tick) points[points.length - 1] = { tick: e.tick, bpm: e.bpm, at: last.at };
      else points.push({ tick: e.tick, bpm: e.bpm, at });
    }
    this.points = points;
  }

  seconds(tick: number): number {
    const points = this.points;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const p = points[lo];
    return p.at + ((tick - p.tick) / TICKS_PER_QUARTER) * (60 / p.bpm);
  }
}

/** A bar in playback order (repeats unrolled). */
export interface PlayedBar {
  /** The master bar's index in the score. */
  index: number;
  startTick: number;
  endTick: number;
  /** Seconds. */
  start: number;
  end: number;
  /** Beat times, seconds; the first is `start`. */
  beats: number[];
}

/** Ticks per counted beat: quarters in x/4, dotted quarters in 6/8 9/8 12/8, eighths in 5/8 7/8. */
export function beatTicks(numerator: number, denominator: number): number {
  const unit = (4 / denominator) * TICKS_PER_QUARTER;
  if (denominator >= 8 && numerator % 3 === 0 && numerator > 3) return unit * 3;
  return unit;
}

export interface Timeline {
  bars: PlayedBar[];
  tempo: TempoMap;
  /** Seconds at the end of the last bar. */
  end: number;
}

export function timeline(score: model.Score, made: MidiOfScore = scoreMidi(score)): Timeline {
  const tempo = new TempoMap(made.midiFile, score.tempo);
  const lookup = made.generator.tickLookup.masterBars;
  const bars = lookup.map((entry): PlayedBar => {
    const master = entry.masterBar;
    const step = beatTicks(master.timeSignatureNumerator, master.timeSignatureDenominator);
    const beats: number[] = [];
    // The last beat must fit: a bar shorter than its meter (a pickup) has fewer beats.
    for (let tick = entry.start; tick < entry.end - step / 4; tick += step) beats.push(tempo.seconds(tick));
    return {
      index: master.index,
      startTick: entry.start,
      endTick: entry.end,
      start: tempo.seconds(entry.start),
      end: tempo.seconds(entry.end),
      beats: beats.length ? beats : [tempo.seconds(entry.start)],
    };
  });
  return { bars, tempo, end: bars.length ? bars[bars.length - 1].end : 0 };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Beats per minute (median) and beats per bar (most common) of the played bars. */
export function tempoAndMeter(bars: PlayedBar[]): { tempo: number; meter: number } {
  const beats = bars.flatMap((b) => b.beats);
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) if (beats[i] > beats[i - 1]) gaps.push(beats[i] - beats[i - 1]);
  const gap = median(gaps);
  const counts = new Map<number, number>();
  for (const bar of bars) counts.set(bar.beats.length, (counts.get(bar.beats.length) ?? 0) + 1);
  let meter = 4;
  let best = 0;
  for (const [n, c] of counts) if (c > best || (c === best && n === 4)) [meter, best] = [n, c];
  return { tempo: gap > 0 ? Math.round((60 / gap) * 100) / 100 : 0, meter: Math.min(7, Math.max(2, meter)) };
}

// ---- what the score says

const SECTION_KINDS: [RegExp, SectionKind][] = [
  [/вступ|intro|начало/i, 'intro'],
  [/предприп|pre-?chorus/i, 'verse'],
  [/припев|chorus|refrain/i, 'chorus'],
  [/куплет|verse|запев/i, 'verse'],
  [/соло|solo/i, 'solo'],
  [/бридж|bridge|переход|middle/i, 'bridge'],
  [/конц|кода|coda|outro|финал|end/i, 'outro'],
];

export function sectionKind(name: string): SectionKind {
  for (const [pattern, kind] of SECTION_KINDS) if (pattern.test(name)) return kind;
  return 'other';
}

/** The file's section marks in playback order; a name used more than once gets a number, a missing one stays ''. */
export function scoreSections(score: model.Score, line: Timeline): Section[] {
  const marks = line.bars.flatMap((bar) => {
    const section = score.masterBars[bar.index]?.section;
    if (!section) return [];
    const name = (section.text || section.marker || '').replace(/\s+/g, ' ').trim();
    return [{ start: bar.start, name }];
  });
  const totals = new Map<string, number>();
  for (const m of marks) totals.set(m.name.toLowerCase(), (totals.get(m.name.toLowerCase()) ?? 0) + 1);
  const seen = new Map<string, number>();
  return marks.map((m, i) => {
    const key = m.name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    // A mark without a name stays '': the main thread names it in the current language (tabSource.ts).
    const name = m.name && (totals.get(key) ?? 0) > 1 ? `${m.name} ${n}` : m.name;
    const end = i + 1 < marks.length ? marks[i + 1].start : line.end;
    return { start: round3(m.start), end: round3(end), kind: sectionKind(m.name), name };
  });
}

/** Chord names written in the file, as chord labels; each holds until the next (at most a few bars). */
export function scoreChords(score: model.Score, line: Timeline): ChordSegment[] {
  const marks: { time: number; bar: number; label: string }[] = [];
  line.bars.forEach((bar, n) => {
    for (const track of score.tracks) {
      if (isPercussion(track)) continue;
      for (const voice of track.staves[0]?.bars[bar.index]?.voices ?? []) {
        for (const beat of voice.beats) {
          const name = beat.chord?.name?.trim();
          const parsed = name ? parseChordText(name) : null;
          if (!parsed) continue;
          marks.push({ time: line.tempo.seconds(bar.startTick + beat.playbackStart), bar: n, label: chordLabel(parsed.chord) });
        }
      }
    }
  });
  marks.sort((a, b) => a.time - b.time);
  const segments: ChordSegment[] = [];
  marks.forEach((m, i) => {
    if (i > 0 && Math.abs(marks[i - 1].time - m.time) < 1e-3) return; // two parts name the same chord
    const lastBar = line.bars[Math.min(line.bars.length - 1, m.bar + CHORD_HOLD_BARS - 1)];
    const next = marks.slice(i + 1).find((x) => x.time > m.time + 1e-3);
    const end = Math.min(next ? next.time : line.end, lastBar.end);
    const previous = segments[segments.length - 1];
    if (previous && previous.chord === m.label && Math.abs(previous.end - m.time) < 1e-3) previous.end = round3(end);
    else segments.push({ start: round3(m.time), end: round3(end), chord: m.label });
  });
  return segments;
}

/** The notes of one part in playback order; tied notes become one. Empty for a drum part. */
export function partNotes(score: model.Score, part: number, line: Timeline): GuitarNote[] {
  const track = score.tracks[part];
  if (!track || isPercussion(track)) return [];
  const notes: GuitarNote[] = [];
  /** The last note per string (and pitch, for a tie), to extend it. */
  const ringing = new Map<string, GuitarNote>();
  for (const bar of line.bars) {
    for (const staff of track.staves) {
      for (const voice of staff.bars[bar.index]?.voices ?? []) {
        for (const beat of voice.beats) {
          if (beat.isRest) continue;
          const start = line.tempo.seconds(bar.startTick + beat.playbackStart);
          const end = line.tempo.seconds(bar.startTick + beat.playbackStart + beat.playbackDuration);
          for (const note of beat.notes) {
            if (note.isDead) continue;
            const key = `${staff.index}:${note.string}:${note.realValue}`;
            const held = ringing.get(key);
            if (note.isTieDestination && held && Math.abs(held.end - start) < 0.01) {
              held.end = round3(end);
              continue;
            }
            const played: GuitarNote = { start: round3(start), end: round3(end), midi: note.realValue };
            notes.push(played);
            ringing.set(key, played);
          }
        }
      }
    }
  }
  return notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** The key from how long each pitch class sounds (Krumhansl–Schmuckler). Null without notes. */
export function keyFromNotes(notes: GuitarNote[]): Analysis['key'] {
  const weight = new Array<number>(12).fill(0);
  for (const n of notes) weight[pitchClass(n.midi)] += Math.max(0.05, n.end - n.start);
  return keyFromWeights(weight);
}

/** The key from the chords' tones, the root counted twice (the harmony, when the file names it). */
export function keyFromChords(chords: ChordSegment[]): Analysis['key'] {
  const weight = new Array<number>(12).fill(0);
  for (const segment of chords) {
    const chord = parseChord(segment.chord);
    if (!chord) continue;
    const length = Math.max(0.05, segment.end - segment.start);
    chordTones(chord).forEach((pc, i) => (weight[pc] += i === 0 ? 2 * length : length));
  }
  return keyFromWeights(weight);
}

function keyFromWeights(weight: number[]): Analysis['key'] {
  if (weight.every((w) => w === 0)) return null;
  let best: { tonic: number; mode: 'major' | 'minor'; r: number } = { tonic: 0, mode: 'major', r: -2 };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = weight.map((_, i) => weight[(i + tonic) % 12]);
    const major = correlation(rotated, MAJOR_PROFILE);
    const minor = correlation(rotated, MINOR_PROFILE);
    if (major > best.r) best = { tonic, mode: 'major', r: major };
    if (minor > best.r) best = { tonic, mode: 'minor', r: minor };
  }
  return { tonic: best.tonic, mode: best.mode, confidence: Math.round(Math.max(0, best.r) * 100) / 100 };
}

/** The share of the song the named chords must cover to say the key. */
const CHORD_KEY_COVER = 0.3;

const chordCover = (chords: ChordSegment[]) => chords.reduce((sum, c) => sum + (c.end - c.start), 0);

/** Every pitched part's notes (for the key). */
function allNotes(score: model.Score, line: Timeline): GuitarNote[] {
  return score.tracks.flatMap((track, i) => (isPercussion(track) ? [] : partNotes(score, i, line)));
}

/** The song's analysis made from the score itself. `duration`: the song's length in the player. */
export function tabAnalysis(score: model.Score, part: number, made: MidiOfScore = scoreMidi(score)): Analysis {
  const line = timeline(score, made);
  const { tempo, meter } = tempoAndMeter(line.bars);
  const chords = scoreChords(score, line);
  return {
    version: TAB_ANALYSIS_VERSION,
    source: 'tab',
    beats: line.bars.flatMap((b) => b.beats).map(round3),
    downbeats: line.bars.map((b) => round3(b.start)),
    tempo,
    meter,
    chords,
    // The chords the file names say the key better than the notes (a riff's passing notes, the
    // major third of a dominant chord) — when they cover a good part of the song, not a few bars.
    key: chordCover(chords) >= CHORD_KEY_COVER * line.end ? keyFromChords(chords) : keyFromNotes(allNotes(score, line)),
    tuningCents: 0,
    sections: scoreSections(score, line),
    tone: null,
    notes: partNotes(score, part, line),
    notesMissing: false,
  };
}

/** What the service keeps about a new tab-song (the length and loudness come from the render). */
export interface TabSongFacts {
  title: string;
  artist: string;
  tempo: number;
  meter: number;
  /** The part shown first. */
  track: number;
  /** The shown part's capo. */
  capo: number;
  /** The parts' names as the file has them: '' for an unnamed one (tabSource.ts names it). */
  trackNames: string[];
  /** Seconds at the end of the last bar. */
  end: number;
}

export function tabSongFacts(score: model.Score, made: MidiOfScore = scoreMidi(score)): TabSongFacts {
  const line = timeline(score, made);
  const track = pickPart(score);
  return {
    title: score.title.trim(),
    artist: score.artist.trim(),
    ...tempoAndMeter(line.bars),
    track,
    capo: score.tracks[track]?.staves[0]?.capo ?? 0,
    trackNames: score.tracks.map((t) => t.name.trim()),
    end: line.end,
  };
}
