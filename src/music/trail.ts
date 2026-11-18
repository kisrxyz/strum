// The played notes that light up on the fretboard: each new note once, fading out after it stops.

export interface TrailItem {
  midi: number;
  /** When the note was last heard (the same clock as `push`, ms). */
  at: number;
  /** 1 while it rings, down to 0 two seconds after. */
  alpha: number;
}

/** A note fades out over this long, ms. */
const FADE_MS = 2000;
/** The same note after at least this long without a note is played again, ms. */
const REPEAT_GAP_MS = 150;
const MAX_ITEMS = 12;

export class NoteTrail {
  private list: { midi: number; at: number }[] = [];
  /** The note ringing now, null in a pause. */
  private current: number | null = null;
  /** The last note heard and when the pause after it began. */
  private last: number | null = null;
  private silentSince = 0;

  /**
   * The tuner's stable note now (MIDI) or null. Returns the note when it is a new one: a different
   * note, or the same note again after at least 150 ms without a note; else null.
   */
  push(midi: number | null, now: number): number | null {
    if (midi === null) {
      if (this.current !== null) this.silentSince = now;
      this.current = null;
      return null;
    }
    const ringingOn = midi === this.current || (this.current === null && midi === this.last && now - this.silentSince < REPEAT_GAP_MS);
    this.current = midi;
    this.last = midi;
    if (ringingOn) {
      const item = this.list.find((i) => i.midi === midi);
      if (item) {
        item.at = now;
        return null;
      }
    }
    this.list = this.list.filter((i) => i.midi !== midi && now - i.at < FADE_MS);
    this.list.push({ midi, at: now });
    if (this.list.length > MAX_ITEMS) this.list.splice(0, this.list.length - MAX_ITEMS);
    return midi;
  }

  /** The notes still glowing at `now`, oldest first. */
  items(now: number): TrailItem[] {
    return this.list
      .filter((i) => now - i.at < FADE_MS)
      .map((i) => ({ midi: i.midi, at: i.at, alpha: Math.min(1, 1 - (now - i.at) / FADE_MS) }));
  }
}
