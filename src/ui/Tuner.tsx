import { useEffect, useRef } from 'react';
import { tuneState } from '../dsp/notes';
import { getLanguage } from '../i18n';
import { useLang } from '../i18n/useLang';
import { useEngineFrame } from './useEngineFrame';

/** Chromatic tuner. Updates the DOM directly every frame (no React re-renders). */
export function Tuner({ size }: { size: 'compact' | 'big' }) {
  const root = useRef<HTMLDivElement>(null);
  const noteEl = useRef<HTMLSpanElement>(null);
  const accEl = useRef<HTMLSpanElement>(null);
  const octaveEl = useRef<HTMLSpanElement>(null);
  const solfegeEl = useRef<HTMLSpanElement>(null);
  const centsEl = useRef<HTMLSpanElement>(null);
  const stringEl = useRef<HTMLSpanElement>(null);
  const shown = useRef({ key: '', cents: Number.NaN, string: '' });
  const t = useLang();
  // Another language: the next frame writes the words again.
  useEffect(() => {
    shown.current = { key: '-', cents: Number.NaN, string: '-' };
  }, [t]);

  useEngineFrame((s) => {
    const el = root.current;
    if (!el) return;
    const last = shown.current;
    if (!s.note) {
      if (last.key !== '') {
        last.key = '';
        last.string = '';
        el.dataset.state = 'idle';
        if (noteEl.current) noteEl.current.textContent = '—';
        if (accEl.current) accEl.current.textContent = '';
        if (octaveEl.current) octaveEl.current.textContent = '';
        if (solfegeEl.current) solfegeEl.current.textContent = t.input.playNote;
        if (centsEl.current) centsEl.current.textContent = '';
        if (stringEl.current) stringEl.current.textContent = '';
        el.style.setProperty('--cents', '0');
      }
      return;
    }
    const key = `${s.note.name}${s.note.octave}`;
    if (key !== last.key) {
      last.key = key;
      // The letter and its ♯ apart: the sign is set smaller and raised.
      if (noteEl.current) noteEl.current.textContent = s.note.name.charAt(0);
      if (accEl.current) accEl.current.textContent = s.note.name.slice(1);
      if (octaveEl.current) octaveEl.current.textContent = String(s.note.octave);
      // Do, re, mi under the letter is a Russian habit: English shows the letter only.
      if (solfegeEl.current) solfegeEl.current.textContent = getLanguage() === 'ru' ? s.note.solfege : '';
    }
    const cents = Math.round(s.note.cents);
    if (cents !== last.cents) {
      last.cents = cents;
      el.dataset.state = tuneState(s.note.cents);
      el.style.setProperty('--cents', String(Math.max(-50, Math.min(50, s.note.cents))));
      if (centsEl.current) centsEl.current.textContent = cents > 0 ? `+${cents}` : String(cents);
    }
    const stringText = s.string && Math.abs(s.string.cents) <= 50 ? t.input.stringName(s.string.stringNumber) : '';
    if (stringText !== last.string) {
      last.string = stringText;
      if (stringEl.current) stringEl.current.textContent = stringText;
    }
  });

  return (
    <div ref={root} className={`tuner tuner--${size}`} data-state="idle" aria-label={t.input.tuner}>
      <div className="tuner__note">
        <span ref={noteEl} className="tuner__name">—</span>
        <span ref={accEl} className="tuner__acc" />
        <span ref={octaveEl} className="tuner__octave" />
      </div>
      <div className="tuner__side">
        <div className="tuner__scale" aria-hidden="true">
          <span className="tuner__zone" />
          <span className="tuner__ticks" />
          <span className="tuner__center" />
          <span className="tuner__needle" />
          <span className="tuner__flat">♭</span>
          <span className="tuner__sharp">♯</span>
        </div>
        <div className="tuner__meta">
          <span ref={solfegeEl} className="tuner__solfege">
            {t.input.playNote}
          </span>
          <span ref={centsEl} className="tuner__cents num" data-unit={t.input.centsUnit} />
          <span ref={stringEl} className="tuner__string" />
        </div>
      </div>
    </div>
  );
}
