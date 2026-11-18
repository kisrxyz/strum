// The interface's words. `en` is the source: `ru` has the same shape, so `tsc` catches a missing
// key. The other languages (es, pt, de, fr, ja, zh) are `Partial` copies: a word they do not have is
// shown in English, so a new key never breaks the build. An entry is a string, or a function of
// its values that returns one. Plain code calls `L()` when it builds a text; components call
// `useLang()` (useLang.ts), which re-renders on a switch. The copy rules and the glossary are in
// README.md beside this file.
import { de } from './de';
import type { Dict, PartialDict } from './dict';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { ja } from './ja';
import { getLanguage, type Lang } from './lang';
import { pt } from './pt';
import { ru } from './ru';
import { zh } from './zh';

export type { Dict, PartialDict } from './dict';
export type { Lang } from './lang';
export { getLanguage, setLanguage } from './lang';

/** The program's name. Nothing else spells it out: it may still change. */
export const APP_NAME = 'Strum';

const isBranch = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** `part` over `base`, branch by branch: what `part` lacks stays as in `base`. */
function fill<T>(base: T, part: unknown): T {
  if (!isBranch(base) || !isBranch(part)) return (part === undefined ? base : part) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(part)) out[key] = fill(out[key], value);
  return out as T;
}

const complete = (part: PartialDict): Dict => fill(en, part);

const DICTS: Record<Lang, Dict> = {
  en,
  ru,
  es: complete(es),
  pt: complete(pt),
  de: complete(de),
  fr: complete(fr),
  ja: complete(ja),
  zh: complete(zh),
};

/** The dictionary of the current language. */
export const L = (): Dict => DICTS[getLanguage()];

/** The dictionary of a given language (for a component that already knows it). */
export const dictFor = (lang: Lang): Dict => DICTS[lang];

/** A tooltip with its key: «Loop (R)». */
export const withKey = (label: string, key: string): string => `${label} (${key})`;
