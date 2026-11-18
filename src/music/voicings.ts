// Chord fingerings, generated rather than looked up: every playable way to hold the chord's notes
// within four frets is scored, and the easiest few at different positions are kept, the way a chord
// book lists them (open shape, then barres up the neck).
import { chordIntervals, chordLabel, pitchClass, type Chord } from './chords';

export interface Voicing {
  /** Per string, 6th → 1st, counted from `open` (the capo): −1 muted, 0 open, n = the n-th fret. */
  frets: number[];
  /** Per string: 0 open or muted, 1 index … 4 little finger (the barre is the index, 1). */
  fingers: number[];
  /** The index finger laid across strings `from`…`to` (0 = 6th) at `fret`. */
  barre: { fret: number; from: number; to: number } | null;
  /** The fret a chord box starts at: 1 when the shape fits frets 1–4, else its lowest fret. A box of
   * four frets from here holds every fretted note. */
  baseFret: number;
  /** Lower is easier. For ordering and comparing only, never shown. */
  difficulty: number;
}

/** Highest fret a voicing may use, counted from the capo: with the capo on 9 it is still the 22nd. */
const MAX_FRET = 13;
/** Highest minus lowest fretted fret: four frets under four fingers. */
const MAX_SPAN = 3;
/** Alternatives harder than the easiest voicing by more than this are not offered. */
const MAX_HARDER = 9;
/** suggestCapo: how much easier per chord (time-weighted) the capo must make the song. */
const MIN_SAVING = 1;
const CAPO_MAX = 7;

// Difficulty, in "fingers". The author plays barre chords easily, so a barre costs little; what a
// chord book avoids (muted strings inside the chord, stretches, the bass not on the root) costs a lot.
const COST = {
  finger: 1,
  littleFinger: 0.5,
  barre: 0.6,
  /** A barre that stops below a string left ringing open. */
  barreUnderOpen: 1.5,
  /** A low string left out: the chord sounds thinner. */
  mutedBass: 1,
  /** A high string left out: it has to be damped by a finger. */
  mutedTreble: 2.5,
  /** A string left out between ringing ones. */
  mutedInner: 6,
  bassNotRoot: 5,
  /** By the distance between the highest and the lowest fretted fret. */
  span: [0, 0, 0.25, 2.5],
  /** Per fret the hand moves up from the first one. */
  position: 0.5,
  /** Per fret past the 3rd while open strings ring: the hand is away from the open-chord box. */
  openFar: 2.5,
  /** Fewer than four strings ring: too thin to strum. */
  thin: 2.5,
  /** Per fret of stretch between neighbouring fingers (see stretch()). */
  stretch: 2,
  /** Per string a finger reaches round others (see crossing()). */
  crossing: 1,
};

type Barre = Voicing['barre'];

interface Hand {
  fingers: number[];
  barre: Barre;
}

interface Candidate {
  voicing: Voicing;
  /** What a chord book would print: root in the bass, nothing muted inside, four strings or more,
   * at most one high string damped. Others are offered only when a chord has nothing better. */
  proper: boolean;
}

const CACHE_SIZE = 300;
const cache = new Map<string, Voicing[]>();

/**
 * The chord's fingerings, easiest first, at most `max`, each at a different position (lowest
 * fretted fret). `open` = the open strings at the capo (MIDI, 6th first), so frets count from the
 * capo. Results are cached and shared between calls: treat them as read-only.
 */
export function voicings(chord: Chord, open: readonly number[], max = 4): Voicing[] {
  if (max <= 0 || !open.length) return [];
  const key = `${pitchClass(chord.root)} ${chord.quality} ${open.join(' ')}`;
  let list = cache.get(key);
  if (!list) {
    list = rank(chord, open);
    cache.set(key, list);
    if (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return list.slice(0, max);
}

/** One voicing per position, easiest first; proper ones only, unless the chord has none. */
function rank(chord: Chord, open: readonly number[]): Voicing[] {
  const intervals = chordIntervals(chord.quality);
  const tones = intervals.map((i) => pitchClass(chord.root + i));
  // The perfect fifth may be left out; the root, the third and the colour notes may not.
  const required = intervals.filter((i) => i !== 7).map((i) => pitchClass(chord.root + i));
  const found: Candidate[] = [];
  for (const frets of shapes(tones, open)) {
    const candidate = judge(frets, pitchClass(chord.root), required, open);
    if (candidate) found.push(candidate);
  }
  const pool = found.some((c) => c.proper) ? found.filter((c) => c.proper) : found;
  const sorted = pool
    .map((c) => c.voicing)
    .sort((a, b) => a.difficulty - b.difficulty || position(a.frets) - position(b.frets) || compareFrets(a.frets, b.frets));
  const out: Voicing[] = [];
  const taken = new Set<number>();
  for (const voicing of sorted) {
    const at = position(voicing.frets);
    if (taken.has(at) || (out.length && voicing.difficulty > out[0].difficulty + MAX_HARDER)) continue;
    taken.add(at);
    out.push(voicing);
  }
  return out;
}

/**
 * «Каподастр на 3 — открытые аккорды»: the capo (1–7) that makes the song's chords clearly easier
 * than without it, with how much easier per chord. Null when no capo helps enough.
 */
export function suggestCapo(
  chords: { chord: Chord; seconds: number }[],
  strings: readonly number[],
): { capo: number; saving: number } | null {
  const weights = new Map<string, { chord: Chord; seconds: number }>();
  let total = 0;
  for (const { chord, seconds } of chords) {
    if (!(seconds > 0)) continue;
    const label = chordLabel(chord);
    const entry = weights.get(label);
    if (entry) entry.seconds += seconds;
    else weights.set(label, { chord, seconds });
    total += seconds;
  }
  if (!total) return null;
  const cost = (capo: number): number => {
    const open = strings.map((note) => note + capo);
    let sum = 0;
    for (const { chord, seconds } of weights.values()) {
      const easiest = voicings(chord, open, 1)[0];
      if (!easiest) return Infinity;
      sum += easiest.difficulty * seconds;
    }
    return sum / total;
  };
  const base = cost(0);
  let best: { capo: number; saving: number } | null = null;
  let bestScore = 0;
  for (let capo = 1; capo <= CAPO_MAX; capo++) {
    const saving = base - cost(capo);
    // A tiny preference for the lower capo when two save about the same.
    const score = saving - 0.05 * capo;
    if (saving >= MIN_SAVING && (!best || score > bestScore)) {
      best = { capo, saving: Math.round(saving * 100) / 100 };
      bestScore = score;
    }
  }
  return best;
}

/** Every combination of chord notes (or muted strings) within MAX_SPAN frets. */
function shapes(tones: number[], open: readonly number[]): number[][] {
  const options = open.map((note) => {
    const list = [-1];
    for (let fret = 0; fret <= MAX_FRET; fret++) if (tones.includes(pitchClass(note + fret))) list.push(fret);
    return list;
  });
  const out: number[][] = [];
  const frets: number[] = [];
  const walk = (string: number, lo: number, hi: number): void => {
    if (string === open.length) {
      out.push(frets.slice());
      return;
    }
    for (const fret of options[string]) {
      const nlo = fret > 0 ? Math.min(lo, fret) : lo;
      const nhi = fret > 0 ? Math.max(hi, fret) : hi;
      if (nhi - nlo > MAX_SPAN) continue;
      frets.push(fret);
      walk(string + 1, nlo, nhi);
      frets.pop();
    }
  };
  walk(0, Infinity, -Infinity);
  return out;
}

/** The voicing with its fingering and difficulty, or null when it is not a full, playable chord. */
function judge(frets: number[], root: number, required: number[], open: readonly number[]): Candidate | null {
  const ringing = frets.flatMap((fret, s) => (fret < 0 ? [] : [s]));
  if (ringing.length < 3) return null;
  const notes = ringing.map((s) => open[s] + frets[s]);
  const present = new Set(notes.map(pitchClass));
  if (!required.every((pc) => present.has(pc))) return null;
  const hand = fingering(frets);
  if (!hand) return null;

  const fretted = frets.filter((fret) => fret > 0);
  const lo = fretted.length ? Math.min(...fretted) : 0;
  const hi = fretted.length ? Math.max(...fretted) : 0;
  const lowest = ringing[0];
  const highest = ringing[ringing.length - 1];
  const used = new Set(hand.fingers.filter((f) => f > 0));
  let mutedBass = 0;
  let mutedTreble = 0;
  let mutedInner = 0;
  for (let s = 0; s < frets.length; s++) {
    if (frets[s] >= 0) continue;
    if (s < lowest) mutedBass++;
    else if (s > highest) mutedTreble++;
    else mutedInner++;
  }
  const rootInBass = pitchClass(Math.min(...notes)) === root;

  let cost = used.size * COST.finger;
  if (used.has(4)) cost += COST.littleFinger;
  if (hand.barre) {
    cost += COST.barre;
    if (frets.slice(hand.barre.to + 1).includes(0)) cost += COST.barreUnderOpen;
  }
  cost += mutedBass * COST.mutedBass + mutedTreble * COST.mutedTreble + mutedInner * COST.mutedInner;
  if (!rootInBass) cost += COST.bassNotRoot;
  if (fretted.length) {
    cost += COST.span[hi - lo];
    cost += COST.position * (lo - 1);
    if (frets.includes(0) && hi > 3) cost += COST.openFar * (hi - 3);
  }
  if (ringing.length < 4) cost += COST.thin;
  cost += COST.stretch * stretch(frets, hand);
  cost += COST.crossing * crossing(frets, hand);

  return {
    voicing: {
      frets,
      fingers: hand.fingers,
      barre: hand.barre,
      baseFret: hi <= 4 ? 1 : lo,
      difficulty: Math.round(cost * 100) / 100,
    },
    proper: rootInBass && mutedInner === 0 && ringing.length >= 4 && mutedTreble <= 1,
  };
}

/**
 * Fingers as a chord book gives them: the index at the lowest fret, the others one per fret above
 * it where they fit (else in order), lower strings first on the same fret. The index lies across as
 * a barre when more than four notes are fretted, or for a short barre on the top strings under
 * other fingers (F as xx3211). Null when four fingers are not enough.
 */
function fingering(frets: number[]): Hand | null {
  const fingers = frets.map(() => 0);
  const fretted = frets.flatMap((fret, s) => (fret > 0 ? [s] : []));
  if (!fretted.length) return { fingers, barre: null };
  const lo = Math.min(...fretted.map((s) => frets[s]));
  const atLo = fretted.filter((s) => frets[s] === lo);
  const from = atLo[0];
  const to = atLo[atLo.length - 1];
  let canBarre = atLo.length >= 2;
  for (let s = from; s <= to && canBarre; s++) if (frets[s] < lo) canBarre = false;
  const topBarre = canBarre && atLo.length === to - from + 1 && to === frets.length - 1 && fretted.length >= 4;

  let barre: Barre = null;
  if (fretted.length > 4 || topBarre) {
    if (!canBarre) return null;
    barre = { fret: lo, from, to };
    for (const s of atLo) fingers[s] = 1;
  }
  const rest = fretted.filter((s) => !(barre && frets[s] === lo)).sort((a, b) => frets[a] - frets[b] || a - b);
  const firstFinger = barre ? 2 : 1;
  if (place(rest, frets, fingers, firstFinger, lo, true) || place(rest, frets, fingers, firstFinger, lo, false)) {
    return { fingers, barre };
  }
  return null;
}

/** One finger per fret from the index (`spread`), or simply the next finger; false past the 4th. */
function place(strings: number[], frets: number[], fingers: number[], first: number, lo: number, spread: boolean): boolean {
  let next = first;
  for (const s of strings) {
    const finger = spread ? Math.max(next, frets[s] - lo + 1) : next;
    if (finger > 4) return false;
    fingers[s] = finger;
    next = finger + 1;
  }
  return true;
}

/**
 * Frets beyond one per finger between neighbouring fingers in use (Cm as x31013: the middle finger
 * on 1, the ring finger on 3). An index finger laid as a barre may reach one fret further (B♭ as
 * x13331), as the A-shape barre does.
 */
function stretch(frets: number[], hand: Hand): number {
  const at = [0, 0, 0, 0, 0];
  hand.fingers.forEach((finger, s) => {
    if (finger > 0) at[finger] = frets[s];
  });
  let extra = 0;
  let prev = 0;
  for (let finger = 1; finger <= 4; finger++) {
    if (!at[finger]) continue;
    if (prev) {
      const allowed = finger - prev + (prev === 1 && hand.barre ? 1 : 0);
      extra += Math.max(0, at[finger] - at[prev] - allowed);
    }
    prev = finger;
  }
  return extra;
}

/**
 * Two fingers on one fret that reach round higher fingers on a higher fret between them, counted in
 * strings beyond two (Bm as x20432: index on the A string, middle on the high E, ring and little
 * finger in between). D (xx0232) reaches round one string and costs nothing.
 */
function crossing(frets: number[], hand: Hand): number {
  let extra = 0;
  for (let a = 0; a < frets.length; a++) {
    for (let b = a + 1; b < frets.length; b++) {
      const fa = hand.fingers[a];
      const fb = hand.fingers[b];
      if (!fa || !fb || fa === fb || frets[a] !== frets[b]) continue;
      let under = false;
      for (let c = a + 1; c < b; c++) if (hand.fingers[c] > Math.max(fa, fb) && frets[c] > frets[a]) under = true;
      if (under) extra += Math.max(0, b - a - 2);
    }
  }
  return extra;
}

/** Where the hand is: the lowest fretted fret (0 when nothing is fretted). */
function position(frets: number[]): number {
  const fretted = frets.filter((fret) => fret > 0);
  return fretted.length ? Math.min(...fretted) : 0;
}

function compareFrets(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
