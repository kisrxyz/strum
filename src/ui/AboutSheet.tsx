// About Strum (a link on «Вход»): the version, the license and everything Strum is built on
// (LICENSES.txt and LICENSE from the repository root). The texts load only when it opens.
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
  return (
    <div className="about-sheet" role="dialog" aria-label={words.open(APP_NAME)}>
      <header className="about-sheet__head">
        <h1>
          {APP_NAME} <span className="about-sheet__version num">{words.version(__STRUM_VERSION__)}</span>
        </h1>
        <button type="button" className="btn btn--quiet" onClick={() => useRuntime.getState().patch({ aboutOpen: false })}>
          {t.common.close}
        </button>
      </header>
      <p>{words.free}</p>
      <p>{words.local}</p>
      <h2>{words.builtOn}</h2>
      {loaded ? <pre className="about-sheet__text">{loaded.builtOn}</pre> : <p className="about-sheet__hint">{t.common.loading}</p>}
      {loaded && (
        <details className="about-sheet__gpl">
          <summary>{words.gpl}</summary>
          <pre className="about-sheet__text">{loaded.gpl}</pre>
        </details>
      )}
      <p className="about-sheet__hint">{words.closeHint}</p>
    </div>
  );
}
