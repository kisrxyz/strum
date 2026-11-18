// The Keys sheet (F1 or ?): every key in one place, so the buttons do not have to carry them.
import { KEY_HELP } from '../app/keyHelp';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';

export function KeysSheet() {
  const open = useRuntime((s) => s.keysOpen);
  const t = useLang();
  if (!open) return null;
  return (
    <div className="keys-sheet" role="dialog" aria-label={t.keys.title}>
      <header className="keys-sheet__head">
        <h1>{t.keys.title}</h1>
        <button type="button" className="btn btn--quiet" onClick={() => useRuntime.getState().patch({ keysOpen: false })}>
          {t.common.close}
        </button>
      </header>
      <div className="keys-sheet__groups">
        {KEY_HELP.map(({ group, rows }) => (
          <section key={group} className="keys-sheet__group" aria-label={t.keys.groups[group]}>
            <h2>{t.keys.groups[group]}</h2>
            <dl>
              {rows.map(({ keys, row }) => (
                <div key={row} className="keys-sheet__row">
                  <dt>
                    {keys.map((k) => (
                      <kbd key={k}>{k === 'space' ? t.keys.space : k === 'stage' ? t.keys.stageKey : k}</kbd>
                    ))}
                  </dt>
                  <dd>{t.keys.rows[row]}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="keys-sheet__hint">{t.keys.closeHint}</p>
    </div>
  );
}
