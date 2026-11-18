import { describe, expect, it } from 'vitest';
import { DRAG_PIXELS, dragTo, keyTo, knobAngle, snap, wheelTo } from './knobMath';

describe('knobAngle', () => {
  it('sweeps 270° from −135° at the minimum to +135° at the maximum', () => {
    expect(knobAngle(-24, -24, 12)).toBe(-135);
    expect(knobAngle(12, -24, 12)).toBe(135);
    expect(knobAngle(0, -6, 6)).toBe(0);
    expect(knobAngle(99, 0, 1)).toBe(135);
  });
});

describe('snap', () => {
  it('rounds to the step and stays in range', () => {
    expect(snap(0.26, -6, 6, 0.5)).toBe(0.5);
    expect(snap(-7, -6, 6, 0.5)).toBe(-6);
    expect(snap(0.123, 0, 1, 0.01)).toBe(0.12);
  });
});

describe('dragTo', () => {
  it('turns the whole range in DRAG_PIXELS up, five times slower with Shift', () => {
    expect(dragTo(-6, -DRAG_PIXELS, -6, 6, 0.5, false)).toBe(6);
    expect(dragTo(0, DRAG_PIXELS / 4, -6, 6, 0.5, false)).toBe(-3);
    expect(dragTo(0, -DRAG_PIXELS / 4, -6, 6, 0.5, true)).toBe(0.5);
  });
});

describe('wheelTo', () => {
  it('moves one step per notch, up is more', () => {
    expect(wheelTo(0, -100, -6, 6, 0.5)).toBe(0.5);
    expect(wheelTo(0, 100, -6, 6, 0.5)).toBe(-0.5);
    expect(wheelTo(6, -100, -6, 6, 0.5)).toBe(6);
  });
});

describe('keyTo', () => {
  it('steps with the arrows, jumps with Page keys, ends with Home / End', () => {
    expect(keyTo(0, 'ArrowUp', -6, 6, 0.5)).toBe(0.5);
    expect(keyTo(0, 'ArrowLeft', -6, 6, 0.5)).toBe(-0.5);
    expect(keyTo(0, 'PageUp', -6, 6, 0.5)).toBe(5);
    expect(keyTo(0, 'Home', -6, 6, 0.5)).toBe(-6);
    expect(keyTo(0, 'End', -6, 6, 0.5)).toBe(6);
    expect(keyTo(0, 'KeyA', -6, 6, 0.5)).toBeNull();
  });
});
