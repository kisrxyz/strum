// About Strum (a link on «Вход»): the version, the license and everything Strum is built on
// (LICENSES.txt and LICENSE from the repository root). The texts load only when it opens.
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { APP_NAME } from '../i18n';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';

declare const __STRUM_VERSION__: string;

interface Texts {
  builtOn: string;
  gpl: string;
}

let texts: Promise<Texts> | null = null;
function loadTexts(): Promise<Texts> {
  texts ??= Promise.all([import('../../LICENSES.txt?raw'), import('../../LICENSE?raw')]).then(([built, gpl]) => ({
    // From its first list on: the heading and the license line above it are the sheet's own.
    builtOn: built.default.slice(Math.max(0, built.default.indexOf('The program'))),
    gpl: gpl.default,
  }));
  return texts;
}

export function AboutSheet() {
  const open = useRuntime((s) => s.aboutOpen);
  const t = useLang();
  const [loaded, setLoaded] = useState<Texts | null>(null);
  useEffect(() => {
    if (open && !loaded) void loadTexts().then(setLoaded);
  }, [open, loaded]);
  if (!open) return null;
  const words = t.shell.about;
  const close = () => useRuntime.getState().patch({ aboutOpen: false });
  return (
    <div className="sheet" role="dialog" aria-label={words.open(APP_NAME)} onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet__box sheet__box--narrow">
        <header className="sheet__head">
          <h1>
            {APP_NAME}
            <span className="about__version num">{words.version(__STRUM_VERSION__)}</span>
          </h1>
          <span className="caption">{words.closeHint}</span>
          <button type="button" className="iconbtn" aria-label={t.common.close} onClick={close}>
            <X />
          </button>
        </header>
        <div className="sheet__body about">
          <p>{words.free}</p>
          <p>{words.local}</p>
          <h2>{words.builtOn}</h2>
          {loaded ? <pre className="about__text">{loaded.builtOn}</pre> : <p>{t.common.loading}</p>}
          {loaded && (
            <details className="about__gpl">
              <summary>{words.gpl}</summary>
              <pre className="about__text">{loaded.gpl}</pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
