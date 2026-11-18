// The interface's words. `en` is the source: `ru` has the same shape, so `tsc` catches a missing
// key. An entry is a string, or a function of its values that returns one. Plain code calls `L()`
// when it builds a text; components call `useLang()` (useLang.ts), which re-renders on a switch.
// The copy rules and the glossary are in README.md beside this file.
import type { Dict } from './dict';
import { en } from './en';
import { getLanguage, type Lang } from './lang';
import { ru } from './ru';

export type { Dict } from './dict';
export type { Lang } from './lang';
export { getLanguage, setLanguage } from './lang';

/** The program's name. Nothing else spells it out: it may still change. */
export const APP_NAME = 'Strum';

const DICTS: Record<Lang, Dict> = { en, ru };

/** The dictionary of the current language. */
export const L = (): Dict => DICTS[getLanguage()];

/** The dictionary of a given language (for a component that already knows it). */
export const dictFor = (lang: Lang): Dict => DICTS[lang];

/** A tooltip with its key: «Loop (R)». */
export const withKey = (label: string, key: string): string => `${label} (${key})`;
