import { importer, model, Settings } from '@coderline/alphatab/core';
import { describe, expect, it } from 'vitest';
import { fixDrumParts, partStaves } from './score';

/** The parts a Guitar Pro file brings besides the guitar: a bass, drums, keys. */
const BAND = importer.ScoreLoader.loadAlphaTex(
  String.raw`\tempo 100
\track "Lead" \instrument 27
\staff {tabs}
:4 0.6 2.5 2.4 1.3 |
\track "Bass" \instrument 33
\staff {tabs} \tuning E1 A1 D2 G2
:4 0.4 0.4 0.4 0.4 |
\track "Drums" \instrument percussion
\staff {score}
\articulation defaults
:4 (KickHit) (SnareHit) (KickHit) (SnareHit) |
\track "Keys" \instrument 0
\staff {score}
:4 C4 D4 E4 F4 |`,
  new Settings(),
);
const [lead, bass, drums, keys] = BAND.tracks;
const { Clef } = model;

describe('partStaves', () => {
  it('shows a part with strings as a tab, with its notes above it on demand', () => {
    expect(partStaves(lead, false)).toBe('tab');
    expect(partStaves(lead, true)).toBe('score-tab');
    expect(partStaves(bass, false)).toBe('tab');
  });

  it('shows drums as notes: they have no strings to make a tab of', () => {
    expect(partStaves(drums, false)).toBe('score');
    expect(partStaves(drums, true)).toBe('score');
  });

  it('shows a part the file keeps without a tab (keys, voice) as notes', () => {
    expect(partStaves(keys, false)).toBe('score');
  });

  it('keeps the tab while the part is not known yet', () => {
    expect(partStaves(null, false)).toBe('tab');
    expect(partStaves(null, true)).toBe('score-tab');
  });
});

/**
 * Drums as converters save them to Guitar Pro 5: a string part on the drum channel, its strings
 * tuned to 0, each fret a drum key (36 kick, 38 snare, 42 hi-hat; 27 is Guitar Pro's own key that
 * alphaTab reads as 42).
 */
function band() {
  const score = importer.ScoreLoader.loadAlphaTex(
    String.raw`\track "Guitar" \instrument 27
\staff {tabs}
:4 0.6 2.5 2.4 1.3 |
\track "Drums" \instrument 25
\staff {tabs}
:4 36.6 38.4 42.2 27.1 |`,
    new Settings(),
  );
  const drums = score.tracks[1];
  drums.playbackInfo.primaryChannel = 9;
  drums.staves[0].stringTuning.tunings = [0, 0, 0, 0, 0, 0];
  return score;
}

const notesOf = (track: (typeof BAND.tracks)[number]) =>
  track.staves[0].bars.flatMap((bar) => bar.voices.flatMap((v) => v.beats.flatMap((b) => b.notes)));

describe('fixDrumParts', () => {
  it('makes a string part on the drum channel a drum part: drum notes, no tab of numbers', () => {
    const score = band();
    fixDrumParts(score);
    const drums = score.tracks[1];
    expect(drums.staves[0].isPercussion).toBe(true);
    expect(partStaves(drums, false)).toBe('score');
    expect(notesOf(drums).map((n) => n.percussionArticulation)).toEqual([36, 38, 42, 42]);
    expect(notesOf(drums).every((n) => Number.isNaN(n.fret))).toBe(true);
    // the drum clef, not the bass clef Guitar Pro gives strings tuned that low
    expect(drums.staves[0].bars.map((bar) => bar.clef)).toEqual([Clef.Neutral]);
  });

  it('leaves the other parts alone', () => {
    const score = band();
    fixDrumParts(score);
    expect(score.tracks[0].staves[0].isPercussion).toBe(false);
    expect(notesOf(score.tracks[0]).map((n) => n.fret)).toEqual([0, 2, 2, 1]);
  });

  it('leaves a part on the drum channel that has real strings', () => {
    const score = band();
    score.tracks[1].staves[0].stringTuning.tunings = [64, 59, 55, 50, 45, 40];
    fixDrumParts(score);
    expect(score.tracks[1].staves[0].isPercussion).toBe(false);
    expect(notesOf(score.tracks[1]).map((n) => n.fret)).toEqual([36, 38, 42, 27]);
  });
});
