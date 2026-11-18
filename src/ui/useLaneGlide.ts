import { useEffect, useRef } from 'react';
import { glideHolds, type Glide } from '../song/glide';

/**
 * Moves a lane's strip with the song, like the chord lane: a compositor glide while it plays (so
 * frames the page spends elsewhere cannot make it stutter), a plain transform while it stands.
 * `x(t)` is where the strip must be (px) for song time `t`.
 */
export function useLaneGlide() {
  const rest = useRef<{ el: HTMLElement | null; value: string }>({ el: null, value: '' });
  const glide = useRef<{ el: HTMLElement; anim: Animation; run: Glide } | null>(null);

  useEffect(() => () => glide.current?.anim.cancel(), []);

  return (strip: HTMLElement, x: (t: number) => number, pps: number, now: number, pos: number, rate: number, until: number) => {
    const shift = (px: number) => `translate3d(${px.toFixed(2)}px, 0, 0)`;
    const running = glide.current;
    if (rate > 0) {
      const v = (-pps * rate) / 1000;
      if (running && running.el === strip && glideHolds(running.run, x(pos), v, now)) return;
      running?.anim.cancel();
      const t1 = now + ((until - pos) / rate) * 1000;
      const anim = strip.animate([{ transform: shift(x(pos)) }, { transform: shift(x(until)) }], {
        duration: t1 - now,
        easing: 'linear',
        fill: 'forwards',
      });
      anim.startTime = now;
      glide.current = { el: strip, anim, run: { t0: now, x0: x(pos), v, t1 } };
      rest.current = { el: null, value: '' };
      return;
    }
    if (running) {
      running.anim.cancel();
      glide.current = null;
    }
    const value = shift(x(pos));
    if (value !== rest.current.value || strip !== rest.current.el) {
      rest.current = { el: strip, value };
      strip.style.transform = value;
    }
  };
}
