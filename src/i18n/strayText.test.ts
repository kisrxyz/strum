// Every word a person reads lives in src/i18n. This test fails when a Russian string shows up in
// code anywhere else: it is a text that the English interface would show in Russian.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Files that READ Russian input (that is data, not interface text), with the reason. */
const ALLOWED: Record<string, string> = {
  'lyrics/parse.ts': 'section names and chord words of Russian chord sheets',
  'lyrics/align.ts': 'Russian letters in word matching',
  'music/chordText.ts': 'H for B and Russian chord words in pasted text',
  'tab/tabSong.ts': 'section kinds from Russian markers (SECTION_KINDS)',
  'song/setlist.ts': 'search folds ё into е',
  'i18n/lang.ts': 'the language names, each in its own language',
  'dsp/notes.ts': 'do-re-mi names, which the tuner shows only in Russian',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The code without its comments (a `//` after `:` is a URL, not a comment). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

describe('interface text', () => {
  it('is only in the dictionaries', () => {
    const stray: string[] = [];
    for (const path of files(SRC)) {
      const rel = relative(SRC, path).split(sep).join('/');
      if (rel.startsWith('i18n/ru/') || rel in ALLOWED) continue;
      code(readFileSync(path, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (/[А-Яа-яЁё]/.test(line)) stray.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(stray).toEqual([]);
  });
});
