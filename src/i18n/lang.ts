// The languages of the interface. Kept apart from the dictionaries so that the settings store can
// name the type without importing them.
export type Lang = 'en' | 'ru';

export const LANGS: readonly Lang[] = ['en', 'ru'];

export const isLang = (x: unknown): x is Lang => LANGS.includes(x as Lang);

// The current language lives here, not in index.ts: the dictionaries use `plural()`, which needs it,
// and index.ts imports the dictionaries.
let current: Lang = 'en';

export function setLanguage(lang: Lang): void {
  current = lang;
}

export const getLanguage = (): Lang => current;

/** Each language by its own name, and the switch's label in both: findable from the wrong one. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ru: 'Русский' };
export const LANG_LABEL = 'Language · Язык';
