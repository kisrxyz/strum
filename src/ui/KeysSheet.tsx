// The Keys sheet (F1 or ?): every key in one place, so the buttons do not have to carry them.
import { X } from 'lucide-react';
import { KEY_HELP } from '../app/keyHelp';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';

export function KeysSheet() {
  const open = useRuntime((s) => s.keysOpen);
  const t = useLang();
  if (!open) return null;
  const close = () => useRuntime.getState().patch({ keysOpen: false });
  return (
    <div className="sheet" role="dialog" aria-label={t.keys.title} onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet__box">
        <header className="sheet__head">
          <h1>{t.keys.title}</h1>
          <span className="caption">{t.keys.closeHint}</span>
          <button type="button" className="iconbtn" aria-label={t.common.close} onClick={close}>
            <X />
          </button>
        </header>
        <div className="sheet__body">
          <div className="keys__groups">
            {KEY_HELP.map(({ group, rows }) => (
              <section key={group} className="keys__group" aria-label={t.keys.groups[group]}>
                <h2>{t.keys.groups[group]}</h2>
                <dl>
                  {rows.map(({ keys, row }) => (
                    <div key={row} className="keys__row">
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
        </div>
      </div>
    </div>
  );
}
