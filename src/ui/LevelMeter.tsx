import { useEffect, useRef } from 'react';
import type { LevelZone } from '../dsp/level';
import { useLang } from '../i18n/useLang';
import { useEngineFrame } from './useEngineFrame';

const FLOOR_DB = -60;
const position = (db: number) => Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));

/**
 * Input level bar with a held peak marker. `compact` is a thin bar with no text (it sits inside a
 * button in the top bar, so it is made of spans only); `big` adds the good band and the advice.
 */
export function LevelMeter({ size }: { size: 'compact' | 'big' }) {
  const root = useRef<HTMLElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const hold = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const zone = useRef<LevelZone | null>(null);
  const t = useLang();
  // Another language: the next frame writes the advice again.
  useEffect(() => {
    zone.current = null;
  }, [t]);

  useEngineFrame((s) => {
    if (fill.current) fill.current.style.transform = `scaleX(${position(s.levelDb)})`;
    if (hold.current) hold.current.style.left = `${position(s.holdDb) * 100}%`;
    if (s.zone !== zone.current) {
      zone.current = s.zone;
      const words = t.input.zones[s.zone];
      if (root.current) {
        root.current.dataset.zone = s.zone;
        if (size === 'compact') root.current.title = words;
      }
      if (text.current) text.current.textContent = words;
    }
  });

  if (size === 'compact') {
    return (
      <span
        ref={root}
        className="meter meter--compact"
        data-zone="silent"
        role="meter"
        aria-label={t.input.meter}
        title={t.input.zones.silent}
      >
        <span ref={fill} className="meter__fill" />
      </span>
    );
  }

  return (
    <div ref={(el) => void (root.current = el)} className="meter meter--big" data-zone="silent">
      <span className="meter__track" role="meter" aria-label={t.input.meter}>
        <span className="meter__good" aria-hidden="true" />
        <span ref={fill} className="meter__fill" />
        <span ref={hold} className="meter__hold" />
      </span>
      <p ref={text} className="meter__text">
        {t.input.zones.silent}
      </p>
    </div>
  );
}
