import { describe, expect, it } from 'vitest';
import { ChannelPicker, channelGains, channelStep } from './channel';

function feed(p: ChannelPicker, left: number, right: number, ms: number) {
  let choice = p.update(left, right, 0);
  for (let t = 0; t < ms; t += 16) choice = p.update(left, right, 16);
  return choice;
}

describe('ChannelPicker', () => {
  it('finds a guitar on the right channel (Hi-Z input 2 of UM2 / UMC22)', () => {
    expect(feed(new ChannelPicker(), -90, -20, 400)).toBe('right');
  });

  it('does not jump on a short blip', () => {
    expect(feed(new ChannelPicker(), -90, -20, 100)).toBe('both');
  });

  it('keeps the found channel while the guitar is silent', () => {
    const p = new ChannelPicker();
    feed(p, -90, -20, 400);
    expect(feed(p, -95, -95, 2000)).toBe('right');
  });

  it('uses both channels when they carry the same signal', () => {
    expect(feed(new ChannelPicker(), -20, -21, 1000)).toBe('both');
  });

  it('maps a choice to channel gains', () => {
    expect(channelGains('left')).toEqual([1, 0]);
    expect(channelGains('right')).toEqual([0, 1]);
    expect(channelGains('both')).toEqual([0.5, 0.5]);
  });

  it('knows how much louder the guitar’s side gets when the pick changes', () => {
    // The step is the ratio of the guitar's own gain, whichever side it is on.
    expect(channelStep('both', 'right')).toBe(channelGains('right')[1] / channelGains('both')[1]);
    expect(channelStep('both', 'left')).toBe(2);
    expect(channelStep('right', 'both')).toBe(0.5);
    // Nothing to go by: the first pick, the same pick, one side for the other.
    expect(channelStep(null, 'right')).toBe(1);
    expect(channelStep('right', 'right')).toBe(1);
    expect(channelStep('left', 'right')).toBe(1);
  });
});
