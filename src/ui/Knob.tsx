// A knob, like on an amp. Drag up or down (Shift: finer), scroll the wheel, double-click for the
// default. It takes no focus from a click, so the arrows stay the app's (volume, presets); reached
// with Tab it turns with the arrows, Page keys, Home and End. The value shows while it is touched.
import { useEffect, useRef, useState } from 'react';
import { dragTo, keyTo, knobAngle, wheelTo } from './knobMath';

const R = 19;
const C = 24;

/** A point on the knob's circle, `deg` from straight up. */
function at(deg: number, r = R): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [C + r * Math.sin(rad), C - r * Math.cos(rad)];
}

function arc(from: number, to: number): string {
  if (Math.abs(to - from) < 0.01) return '';
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${x0} ${y0} A ${R} ${R} 0 ${large} ${sweep} ${x1} ${y1}`;
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
  /** The arc starts in the middle (tone controls around 0). */
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
  const start = bipolar ? knobAngle((min + max) / 2, min, max) : -135;
  const [px, py] = at(angle, R - 7);
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
      <svg className="knob__dial" viewBox="0 0 48 48" aria-hidden="true">
        <path className="knob__track" d={arc(-135, 135)} />
        <path className="knob__arc" d={arc(Math.min(start, angle), Math.max(start, angle))} />
        <circle className="knob__cap" cx={C} cy={C} r={R - 5} />
        <line className="knob__pointer" x1={C} y1={C} x2={px} y2={py} />
      </svg>
      <span className="knob__label">{label}</span>
      <span className="knob__value num">{shown}</span>
    </div>
  );
}
