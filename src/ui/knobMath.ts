// The arithmetic of a knob (src/ui/Knob.tsx): angle, drag, wheel and keys. No DOM.

/** The pointer travel (px, upwards) that turns a knob through its whole range. */
export const DRAG_PIXELS = 200;
/** Shift makes a drag this many times finer. */
const FINE = 5;
const SWEEP = 270;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Degrees from straight up: −135 at the minimum, +135 at the maximum. */
export function knobAngle(value: number, min: number, max: number): number {
  const t = max > min ? (clamp(value, min, max) - min) / (max - min) : 0;
  return t * SWEEP - SWEEP / 2;
}

/** The value on the step grid (from `min`), inside the range, free of float dust. */
export function snap(value: number, min: number, max: number, step: number): number {
  const stepped = min + Math.round((value - min) / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return clamp(Number(stepped.toFixed(decimals)), min, max);
}

/** The value after dragging `dy` pixels from where the drag began (negative `dy` is up). */
export function dragTo(start: number, dy: number, min: number, max: number, step: number, fine: boolean): number {
  const perPixel = (max - min) / DRAG_PIXELS / (fine ? FINE : 1);
  return snap(start - dy * perPixel, min, max, step);
}

/** One wheel notch, one step; scrolling up turns it up. */
export function wheelTo(value: number, deltaY: number, min: number, max: number, step: number): number {
  if (deltaY === 0) return value;
  return snap(value + (deltaY < 0 ? step : -step), min, max, step);
}

/** A key on a focused knob, or null when the key is not the knob's. */
export function keyTo(value: number, code: string, min: number, max: number, step: number): number | null {
  switch (code) {
    case 'ArrowUp':
    case 'ArrowRight':
      return snap(value + step, min, max, step);
    case 'ArrowDown':
    case 'ArrowLeft':
      return snap(value - step, min, max, step);
    case 'PageUp':
      return snap(value + step * 10, min, max, step);
    case 'PageDown':
      return snap(value - step * 10, min, max, step);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}
