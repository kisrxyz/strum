// The settings' language → the dictionary. Kept apart from index.ts so that plain modules can call
// `L()` without loading the settings store.
import { useSettings } from '../state/settings';
import { dictFor, setLanguage, type Dict, type Lang } from './index';

/** The dictionary for a component; it re-renders when the language changes. */
export function useLang(): Dict {
  return dictFor(useSettings((s) => s.language));
}

let bound = false;

/**
 * Makes `L()` follow the settings, at once and on every change. Zustand calls subscribers
 * synchronously, so `L()` already has the new language when React re-renders.
 */
export function bindLanguage(): void {
  if (bound) return;
  bound = true;
  const apply = (lang: Lang) => {
    setLanguage(lang);
    // Screen readers and Chrome's translate offer go by the page's own language.
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  };
  apply(useSettings.getState().language);
  useSettings.subscribe((s) => apply(s.language));
}
