// Picks the input channel the guitar is plugged into (2-channel interfaces put Hi-Z on input 2).

export type ChannelChoice = 'left' | 'right' | 'both';
export type ChannelMode = 'auto' | ChannelChoice;

export class ChannelPicker {
  private choice: ChannelChoice = 'both';
  private candidate: ChannelChoice | null = null;
  private candidateMs = 0;

  constructor(
    private readonly marginDb = 12,
    private readonly confirmMs = 300,
    private readonly minDb = -60,
  ) {}

  get current(): ChannelChoice {
    return this.choice;
  }

  /** Feed per-channel RMS in dB every frame; returns the channel to use. */
  update(leftDb: number, rightDb: number, dtMs: number): ChannelChoice {
    if (Math.max(leftDb, rightDb) < this.minDb) {
      // Silence says nothing about where the guitar is: keep the last choice.
      this.candidate = null;
      this.candidateMs = 0;
      return this.choice;
    }
    let next: ChannelChoice = 'both';
    if (leftDb - rightDb >= this.marginDb) next = 'left';
    else if (rightDb - leftDb >= this.marginDb) next = 'right';

    if (next === this.choice) {
      this.candidate = null;
      this.candidateMs = 0;
      return this.choice;
    }
    if (next !== this.candidate) {
      this.candidate = next;
      this.candidateMs = 0;
    }
    this.candidateMs += dtMs;
    if (this.candidateMs >= this.confirmMs) {
      this.choice = next;
      this.candidate = null;
      this.candidateMs = 0;
    }
    return this.choice;
  }
}

export function channelGains(choice: ChannelChoice): [number, number] {
  if (choice === 'left') return [1, 0];
  if (choice === 'right') return [0, 1];
  return [0.5, 0.5];
}

/**
 * How many times louder the guitar's own input gets when the pick changes — and its noise with
 * it: ×2 from «both» (half of each) to one side, ×0.5 back. The gate that learned the noise floor
 * moves it by the same step («Шумодав сам»): the pick is made on the first note, and without this
 * the gate would stay open on the doubled noise for five seconds after that first phrase.
 * Between the two sides nothing is known: 1.
 */
export function channelStep(from: ChannelChoice | null, to: ChannelChoice): number {
  if (from === null || from === to) return 1;
  if (from === 'both') return 2;
  if (to === 'both') return 0.5;
  return 1;
}
