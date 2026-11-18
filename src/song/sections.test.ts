import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n';
import { sectionLabel } from './sections';
import type { Section, SectionKind } from './types';

afterEach(() => setLanguage('en'));

const of = (kinds: SectionKind[], names: string[] = []): Section[] =>
  kinds.map((kind, i) => ({ start: i * 10, end: i * 10 + 10, kind, name: names[i] ?? 'Куплет 9' }));

const labels = (sections: Section[], fromFile = false) => sections.map((_, i) => sectionLabel(sections, i, fromFile));

describe('sectionLabel', () => {
  const kinds: SectionKind[] = ['intro', 'verse', 'chorus', 'verse', 'chorus', 'solo', 'outro'];

  it('names analysed sections by kind, numbering verses and choruses', () => {
    setLanguage('en');
    expect(labels(of(kinds))).toEqual(['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Solo', 'Outro']);
  });

  it('speaks Russian too, whatever name an old analysis stored', () => {
    setLanguage('ru');
    expect(labels(of(kinds))).toEqual(['Вступление', 'Куплет 1', 'Припев 1', 'Куплет 2', 'Припев 2', 'Соло', 'Концовка']);
  });

  it('numbers another kind only when it comes more than once, and parts always', () => {
    setLanguage('en');
    expect(labels(of(['solo', 'bridge', 'solo', 'other', 'other']))).toEqual(['Solo 1', 'Bridge', 'Solo 2', 'Part 1', 'Part 2']);
    expect(labels(of(['verse']))).toEqual(['Verse 1']);
  });

  it("keeps a tab file's own markers", () => {
    expect(labels(of(['verse', 'other'], ['Куплет', 'Bridge riff']), true)).toEqual(['Куплет', 'Bridge riff']);
  });

  it('is empty past the end', () => {
    expect(sectionLabel(of(['verse']), 3, false)).toBe('');
  });
});
