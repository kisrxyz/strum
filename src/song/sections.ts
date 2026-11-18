// What a song section is called on screen. An analysed song's sections are named here, by kind and
// number, in the current language: the name the service stored (Russian in older analyses) is not
// shown. A tab-song's sections are the file's own markers and keep their names.
import { L } from '../i18n';
import type { Section, SectionKind } from './types';

/** Kinds numbered even when they come once (as the service names them, sections.py). */
const ALWAYS_NUMBERED: ReadonlySet<SectionKind> = new Set(['verse', 'chorus', 'other']);

export function sectionLabel(sections: readonly Section[], index: number, fromFile: boolean): string {
  const section = sections[index];
  if (!section) return '';
  if (fromFile) return section.name;
  const { kind } = section;
  const total = sections.filter((s) => s.kind === kind).length;
  const word = L().sections[kind] ?? L().sections.other;
  if (!ALWAYS_NUMBERED.has(kind) && total < 2) return word;
  const number = sections.slice(0, index + 1).filter((s) => s.kind === kind).length;
  return `${word} ${number}`;
}
