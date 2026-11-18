// Text tabs as people paste them (six lines of dashes and fret numbers) → alphaTex, which alphaTab
// draws like any tab. A text tab has no rhythm: every beat becomes an eighth note.
import { L } from '../i18n';

/** A tab line: an optional string name, a bar line, then mostly dashes and digits. */
const TAB_LINE = /^\s*([A-Ga-g][#b]?|[1-6])?\s*[|:]?[-0-9|hpbrx/\\~^()<>.=*sSlL ]*-[-0-9|hpbrx/\\~^()<>.=*sSlL ]*$/;
const MIN_DASHES = 4;

function isTabLine(line: string): boolean {
  return TAB_LINE.test(line) && (line.match(/-/g)?.length ?? 0) >= MIN_DASHES;
}

/** The six-line blocks of a text (each block: its lines from the thinnest string down). */
function blocks(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[][] = [];
  for (let i = 0; i + 6 <= lines.length; i++) {
    const six = lines.slice(i, i + 6);
    if (six.every(isTabLine) && !(lines[i + 6] !== undefined && isTabLine(lines[i + 6]))) {
      out.push(six);
      i += 5;
    }
  }
  return out;
}

export function isTextTab(text: string): boolean {
  return blocks(text).length > 0;
}

/** What follows the string name and the first bar line. */
function body(line: string): string {
  const match = /^\s*(?:[A-Ga-g][#b]?|[1-6])?\s*[|:]?/.exec(line);
  return line.slice(match ? match[0].length : 0);
}

/** alphaTex of the text tab, or null when nothing readable is in it. */
export function textTabToAlphaTex(text: string): string | null {
  const bars: string[][] = [];
  let current: string[] = [];
  for (const block of blocks(text)) {
    const rows = block.map(body);
    const width = Math.min(...rows.map((r) => r.length));
    const skip = rows.map(() => 0); // the second digit of a two-digit fret
    for (let c = 0; c < width; c++) {
      if (rows.every((r) => r[c] === '|')) {
        if (current.length) bars.push(current);
        current = [];
        continue;
      }
      const notes: string[] = [];
      rows.forEach((row, s) => {
        if (skip[s] > c) return;
        if (!/\d/.test(row[c])) return;
        let fret = row[c];
        if (/\d/.test(row[c + 1] ?? '') && Number(row[c] + row[c + 1]) <= 24) {
          fret += row[c + 1];
          skip[s] = c + 2;
        }
        notes.push(`${Number(fret)}.${s + 1}`); // alphaTex string 1 = the thinnest
      });
      if (notes.length) current.push(notes.length === 1 ? notes[0] : `(${notes.join(' ')})`);
    }
  }
  if (current.length) bars.push(current);
  if (!bars.length) return null;
  return `\\title "${L().actions.tab.pastedName}" . :8 ${bars.map((beats) => beats.join(' ')).join(' | ')}`;
}
