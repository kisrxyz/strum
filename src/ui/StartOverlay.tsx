import { engine } from '../audio/engine';
import { APP_NAME, type Dict } from '../i18n';
import { useLang } from '../i18n/useLang';
import { useRuntime, type EngineErrorKind } from '../state/runtime';
import { useSettings } from '../state/settings';
import { micHint } from './guitarInput';

function errorText(kind: EngineErrorKind, t: Dict): string {
  const errors = t.shell.start.errors;
  switch (kind) {
    case 'permission':
      return errors.permission;
    case 'no-device':
      return errors.noDevice;
    case 'busy':
      return errors.busy;
    case 'unsupported':
      return errors.unsupported(APP_NAME);
    case 'other':
      return errors.other;
  }
}

export function StartOverlay() {
  const status = useRuntime((s) => s.status);
  const error = useRuntime((s) => s.error);
  const link = useRuntime((s) => s.native.link);
  const choice = useSettings((s) => s.guitarEngine);
  const t = useLang();
  if (status === 'running') return null;
  const hint = micHint(choice, link);
  const start = t.shell.start;

  return (
    <div className="launch" role="dialog" aria-modal="true" aria-label={start.label}>
      <h1 className="launch__title">{APP_NAME}</h1>
      {status === 'starting' ? (
        <>
          <p className="launch__lead">{start.starting}</p>
          {hint && <p className="launch__hint">{hint}</p>}
        </>
      ) : status === 'error' && error ? (
        <>
          <p className="launch__error">{errorText(error.kind, t)}</p>
          {error.kind === 'other' && error.detail && <p className="launch__hint">{error.detail}</p>}
          <button type="button" className="btn btn--primary btn--big" onClick={() => void engine.start()}>
            {t.common.retry} <kbd>{start.space}</kbd>
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--primary btn--big launch__go" onClick={() => void engine.start()}>
          {/* One flex item: the button's gap must not land before the comma. */}
          <span>
            {start.pressBefore} <kbd>{start.space}</kbd>
            {start.pressAfter}
          </span>
        </button>
      )}
    </div>
  );
}
