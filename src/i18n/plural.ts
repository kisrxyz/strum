import { getLanguage } from './lang';

/** The forms of a word by number. English needs `one` and `other`; Russian adds `few` and `many`. */
export interface PluralForms {
  one: string;
  few?: string;
  many?: string;
  other: string;
}

const rules = new Map<string, Intl.PluralRules>();

/** The form for `n` in the current language: 1 песня, 2 песни, 5 песен, 21 песня. */
export function plural(n: number, forms: PluralForms): string {
  const lang = getLanguage();
  let rule = rules.get(lang);
  if (!rule) rules.set(lang, (rule = new Intl.PluralRules(lang)));
  const kind = rule.select(n) as keyof PluralForms | 'zero' | 'two';
  return (kind in forms ? forms[kind as keyof PluralForms] : undefined) ?? forms.other;
}
