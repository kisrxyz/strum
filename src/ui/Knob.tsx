// A knob, like on an amp: a body with a pointer inside a ring of marks that light up to the value.
// Drag up or down (Shift: finer), scroll the wheel, double-click for the default. It takes no focus
// from a click, so the arrows stay the app's (volume, presets); reached with Tab it turns with the
// arrows, Page keys, Home and End. The value shows in place of the name while it is touched.
import { useEffect, useRef, useState } from 'react';
import { dragTo, keyTo, knobAngle, wheelTo } from './knobMath';

/** The marks around the dial: eleven, from −135° to +135°. */
const MARKS = Array.from({ length: 11 }, (_, i) => -135 + i * 27);
const C = 32;

/** A point `r` from the centre of the 64 px drawing, `deg` from straight up. */
function at(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [C + r * Math.sin(rad), C - r * Math.cos(rad)];
}

export function Knob(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Double-click goes back here. */
  defaultValue: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  /** The marks light from the middle (tone controls around 0). */
  bipolar?: boolean;
  size?: 'big' | 'small';
  disabled?: boolean;
  /** Tooltip: what the knob does (the value is added to it). */
  hint?: string;
}) {
  const { label, value, min, max, step, defaultValue, format, onChange, bipolar, size = 'big', disabled, hint } = props;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; value: number } | null>(null);
  const [active, setActive] = useState(false);
  const latest = useRef({ value, onChange, disabled });
  latest.current = { value, onChange, disabled };

  // React's wheel listeners are passive: this one must stop the page from scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (latest.current.disabled) return;
      e.preventDefault();
      const next = wheelTo(latest.current.value, e.deltaY, min, max, step);
      if (next !== latest.current.value) latest.current.onChange(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [min, max, step]);

  const angle = knobAngle(value, min, max);
  const from = bipolar ? Math.min(0, angle) : -135;
  const to = bipolar ? Math.max(0, angle) : angle;
  const shown = format(value);

  return (
    <div
      ref={ref}
      className={`knob knob--${size}${active ? ' knob--active' : ''}${disabled ? ' knob--off' : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={shown}
      aria-disabled={disabled || undefined}
      title={hint ? `${label}: ${shown}. ${hint}` : `${label}: ${shown}`}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        // The knob takes no focus, so a select or slider that had it would keep the arrows: drop it.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, value };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const next = dragTo(drag.current.value, e.clientY - drag.current.y, min, max, step, e.shiftKey);
        if (next !== value) onChange(next);
      }}
      onPointerUp={() => {
        drag.current = null;
        setActive(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={() => !disabled && onChange(defaultValue)}
      onKeyDown={(e) => {
        if (disabled) return;
        const next = keyTo(value, e.code, min, max, step);
        if (next === null) return;
        // The knob's own keys must not reach the app's shortcuts (volume, presets).
        e.preventDefault();
        e.stopPropagation();
        if (next !== value) onChange(next);
      }}
    >
      <span className="knob__dial">
        <svg className="knob__marks" viewBox="0 0 64 64" aria-hidden="true">
          {MARKS.map((deg) => {
            const [x1, y1] = at(deg, 27.5);
            const [x2, y2] = at(deg, deg % 135 === 0 ? 31.5 : 30.5);
            const lit = deg >= from - 0.5 && deg <= to + 0.5;
            return <line key={deg} className={lit ? 'is-lit' : undefined} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </svg>
        <span className="knob__body" />
        <span className="knob__turn" style={{ transform: `rotate(${angle}deg)` }}>
          <i />
        </span>
      </span>
      <span className="knob__label">{label}</span>
      <span className="knob__value num">{shown}</span>
    </div>
  );
}
