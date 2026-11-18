// «Подстроить под мою гитару» (Set input level) on «Вход»: listens to a few hard strums (G, or the
// button) and sets the input's own gain so that the hardest one reaches the level the amps were
// levelled for. The verdict goes to the toast: the screen must fit 1280×720 whatever the meter says.
import { useEffect, useRef } from 'react';
import { TRIM_MAX_DB, TrimListener, type TrimResult } from '../dsp/inputTrim';
import { L, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { fmtDb } from './controls';
import { useEngineFrame } from './useEngineFrame';

export function trimVerdictText(result: TrimResult, trimDb: number): string {
  const t = L().input;
  switch (result.verdict) {
    case 'ok':
      return t.trimOk(fmtDb(trimDb));
    case 'clip':
      return t.trimClip(fmtDb(trimDb));
    case 'weak':
      return t.trimWeak(fmtDb(TRIM_MAX_DB));
    case 'silent':
      return t.trimSilent;
  }
}

export function InputTrim() {
  const listening = useRuntime((r) => r.trimListening);
  const patch = useRuntime((r) => r.patch);
  const trimDb = useSettings((s) => s.inputTrimDb);
  const setTrim = useSettings((s) => s.setInputTrim);
  const t = useLang();
  const listener = useRef<TrimListener | null>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const dots = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    listener.current = listening ? new TrimListener(performance.now()) : null;
  }, [listening]);
  // Leaving «Вход» stops it.
  useEffect(() => () => useRuntime.getState().patch({ trimListening: false }), []);

  useEngineFrame((s, now) => {
    const l = listener.current;
    if (!l) return;
    const result = l.push(s.rawPeakDb, now);
    if (fill.current) fill.current.style.transform = `scaleX(${l.progress(now)})`;
    if (dots.current) dots.current.textContent = l.heard ? t.input.trimHeard(l.heard) : t.input.trimWaiting;
    if (!result) return;
    listener.current = null;
    if (result.trimDb !== null) setTrim(result.trimDb);
    patch({ trimListening: false });
    useRuntime.getState().showToast(trimVerdictText(result, result.trimDb ?? trimDb), result.verdict === 'ok' ? 'info' : 'warn');
  });

  if (listening) {
    return (
      <div className="trim" role="status">
        <p className="trim__ask">{t.input.trimAsk}</p>
        <span className="trim__track" aria-hidden="true">
          <span ref={fill} className="trim__fill" />
        </span>
        <p className="trim__line">
          <span ref={dots} className="trim__dots">
            {t.input.trimWaiting}
          </span>
          <button type="button" className="link" title={withKey(t.common.cancel, 'Esc')} onClick={() => patch({ trimListening: false })}>
            {t.common.cancel}
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="trim">
      <p className="trim__line">
        <span>
          {t.input.trimNow}: <b className="num">{trimDb === 0 ? t.input.trimNone : fmtDb(trimDb)}</b>
        </span>
        {trimDb !== 0 && (
          <button type="button" className="link" onClick={() => setTrim(0)}>
            {t.common.reset}
          </button>
        )}
      </p>
      <button type="button" className="btn trim__go" title={withKey(t.input.trim, 'G')} onClick={() => patch({ trimListening: true })}>
        {t.input.trim}
      </button>
    </div>
  );
}
