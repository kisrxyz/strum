// Saving lyrics: .lrc (lines with times, for players) and ChordPro (lines with [chords]).
import type { TimedLine } from './align';
import type { LyricDoc } from './parse';

const stamp = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds * 100));
  const min = Math.floor(total / 6000);
  const sec = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
};

/** `[mm:ss.xx]` + the line's words; lines without words are left out. */
export function toLrc(doc: LyricDoc, lines: TimedLine[], title = '', artist = ''): string {
  const head = [artist && `[ar:${artist}]`, title && `[ti:${title}]`].filter(Boolean);
  const body = lines.filter((l) => doc.lines[l.line].text.trim()).map((l) => `${stamp(l.start)}${doc.lines[l.line].text.trim()}`);
  return [...head, ...body].join('\n') + '\n';
}

/** ChordPro: [chord] before the character it stands over, sections as comments. */
export function toChordPro(doc: LyricDoc, title: string, artist: string): string {
  const out: string[] = [];
  if (title) out.push(`{title: ${title}}`);
  if (artist) out.push(`{artist: ${artist}}`);
  if (doc.capo) out.push(`{capo: ${doc.capo}}`);
  let section: string | null = null;
  for (const line of doc.lines) {
    if (line.section !== section && line.section) out.push(`{comment: ${line.section}}`);
    section = line.section;
    if (!line.text) {
      out.push(line.chords.map((c) => `[${c.text}]`).join(' '));
      continue;
    }
    let text = '';
    let last = 0;
    for (const c of [...line.chords].sort((a, b) => a.at - b.at)) {
      text += line.text.slice(last, c.at) + `[${c.text}]`;
      last = c.at;
    }
    out.push(text + line.text.slice(last));
  }
  return out.join('\n') + '\n';
}
