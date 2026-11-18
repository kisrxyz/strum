import type { ReactNode } from 'react';
import { L } from '../i18n';

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** One line: label, track, value. */
  inline?: boolean;
}) {
  const { label, value, min, max, step, format, onChange, disabled, inline } = props;
  return (
    <label className={`slider${inline ? ' slider--inline' : ''}${disabled ? ' slider--off' : ''}`}>
      <span className="slider__label">{label}</span>
      <span className="slider__value num">{format(value)}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** An on/off switch: the label, then a small track with a knob. */
export function Toggle(props: { label: string; on: boolean; onChange: (on: boolean) => void; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      className={`switch${props.on ? ' switch--on' : ''}`}
      aria-checked={props.on}
      title={props.hint}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="switch__label">{props.label}</span>
      <span className="switch__track" aria-hidden="true">
        <span className="switch__knob" />
      </span>
    </button>
  );
}

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="select">
      <span className="select__label">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
          e.target.blur(); // give the arrow keys back to the shortcuts
        }}
      >
        {props.children}
      </select>
    </label>
  );
}

const units = () => L().common.units;
export const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 1)} ${units().db}`;
export const fmtPct = (v: number) => units().pct(Math.round(v * 100));
export const fmtMs = (v: number) => `${Math.round(v)} ${units().ms}`;
export const fmtHz = (v: number) => `${v.toFixed(v < 1 ? 2 : 1)} ${units().hz}`;
