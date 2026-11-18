// The languages of the interface. Kept apart from the dictionaries so that the settings store can
// name the type without importing them.
export type Lang = 'en' | 'ru' | 'es' | 'pt' | 'de' | 'fr' | 'ja' | 'zh';

/** English and Russian are complete and checked; the rest fall back to English where a word is missing (index.ts). */
export const LANGS: readonly Lang[] = ['en', 'ru', 'es', 'pt', 'de', 'fr', 'ja', 'zh'];

export const isLang = (x: unknown): x is Lang => LANGS.includes(x as Lang);

// The current language lives here, not in index.ts: the dictionaries use `plural()`, which needs it,
// and index.ts imports the dictionaries.
let current: Lang = 'en';

export function setLanguage(lang: Lang): void {
  current = lang;
}

export const getLanguage = (): Lang => current;

/** Each language by its own name: findable from the wrong one. */
export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  pt: 'Português (Brasil)',
  de: 'Deutsch',
  fr: 'Français',
  ja: '日本語',
  zh: '简体中文',
};

/** The locale dates and numbers are written in. */
const LOCALES: Record<Lang, string> = {
  en: 'en-US',
  ru: 'ru-RU',
  es: 'es-ES',
  pt: 'pt-BR',
  de: 'de-DE',
  fr: 'fr-FR',
  ja: 'ja-JP',
  zh: 'zh-CN',
};

export const locale = (): string => LOCALES[current];

/** A decimal figure as the language writes it: 2.7 in English, Japanese and Chinese; 2,7 elsewhere. */
export function decimal(text: string): string {
  return current === 'en' || current === 'ja' || current === 'zh' ? text : text.replace('.', ',');
}

/** The words in the names of downloaded files come from the song service, which has two languages. */
export const fileLang = (): 'en' | 'ru' => (current === 'ru' ? 'ru' : 'en');

/**
 * The language of a first start: the first of the system's languages that Strum speaks, English
 * otherwise. `preferred` is `navigator.languages` ("pt-BR", "de", "zh-Hans-CN"…).
 */
export function detectLanguage(preferred: readonly string[] | undefined): Lang {
  for (const tag of preferred ?? []) {
    const code = tag.toLowerCase().split('-')[0];
    if (isLang(code)) return code;
  }
  return 'en';
}
