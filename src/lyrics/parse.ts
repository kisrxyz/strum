// Lyrics as people paste them: chords over the lines (amdm.ru, Ultimate Guitar), [Am] inside the
// words (ChordPro), timed lines (.lrc), or plain text. One model for all of them: lines with the
// chords at character positions, an optional time per line, the section a line belongs to.
import { L } from '../i18n';
import { chordLabel, transposeChord, parseChord } from '../music/chords';
import { chordColumns, isChordLine, parseChordText, usesGermanB } from '../music/chordText';
import type { ChordLabel } from '../song/types';

export interface LyricChord {
  /** Character index in the line's text (for a line without words: the column it was written at). */
  at: number;
  label: ChordLabel;
  /** As it was written («Hm», «Am/G»). */
  text: string;
}

export interface LyricLine {
  text: string;
  chords: LyricChord[];
  /** Seconds, from a .lrc file; null otherwise. */
  time: number | null;
  /** «Куплет 1», «Припев»… from the heading above it; null when there was none. */
  section: string | null;
}

export type LyricFormat = 'chords-over' | 'chordpro' | 'lrc' | 'plain';

export interface LyricDoc {
  lines: LyricLine[];
  /** «Каподастр на 2» in the text: its chords are shapes played with that capo. */
  capo: number;
  format: LyricFormat;
}

const LRC_STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_LINE = /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const LRC_OFFSET = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i;
const LRC_TAG = /^\s*\[[a-z]+:.*\]\s*$/i;
const DIRECTIVE = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i;
const INLINE_CHORD = /\[([^\]\s]{1,12})\]/g;
const SECTION_WORDS =
  'куплет|припев|пред-?припев|проигрыш|вступление|интро|соло|кода|концовка|бридж|переход|аутро|' +
  'verse|chorus|pre-?chorus|bridge|intro|outro|solo|interlude|coda|instrumental';
const HEADING = new RegExp(`^\\s*[\\[(]?\\s*((?:${SECTION_WORDS})(?:\\s*\\d+)?)\\s*[\\])]?\\s*[:.]?\\s*(.*)$`, 'iu');
const CAPO = /^\s*[([]?\s*(?:каподастр|капо|capo)\s*[:-]?\s*(?:на\s*)?(\d{1,2}|[IVX]{1,4})\b.*$/iu;
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** A tab jumps to the next multiple of 8 columns, as in a browser's <pre>. */
function expandTabs(line: string): string {
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(8 - (out.length % 8)) : ch;
  return out;
}

/** Tabs, odd spaces and line ends as browsers paste them → plain lines. */
function cleanLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[  -   　]/g, ' ')
    .replace(/[​﻿]/g, '')
    .split('\n')
    .map((line) => expandTabs(line).replace(/\s+$/, ''));
}

function capoOf(line: string): number | null {
  const match = CAPO.exec(line);
  if (!match) return null;
  const value = /^\d+$/.test(match[1]) ? Number(match[1]) : (ROMAN[match[1].toUpperCase()] ?? 0);
  return value >= 0 && value <= 12 ? value : null;
}

/** «припев 2:» → «Припев 2». */
function sectionName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/** The base of a section name for finding its repeat: «Припев 2» → «припев». */
const sectionBase = (name: string) => name.toLowerCase().replace(/\s*\d+$/, '');

function label(text: string): ChordLabel | null {
  const parsed = parseChordText(text);
  return parsed ? chordLabel(parsed.chord) : null;
}

function parseLrc(lines: string[]): LyricLine[] {
  let offset = 0;
  const out: LyricLine[] = [];
  for (const line of lines) {
    const off = LRC_OFFSET.exec(line);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    if (!LRC_LINE.test(line)) continue;
    const times: number[] = [];
    for (const m of line.matchAll(LRC_STAMP)) {
      const fraction = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + fraction);
    }
    const text = line.replace(LRC_STAMP, '').trim();
    if (!text) continue;
    for (const time of times) out.push({ text, chords: [], time: Math.max(0, time - offset), section: null });
  }
  // .lrc «offset» is added to the times by players: a positive offset makes lines earlier.
  return out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

/** A line of ChordPro: [Am] tokens out of the text, kept as chords at their positions. */
function chordProLine(line: string): { text: string; chords: LyricChord[] } {
  const chords: LyricChord[] = [];
  let text = '';
  let last = 0;
  for (const m of line.matchAll(INLINE_CHORD)) {
    const index = m.index ?? 0;
    const chord = label(m[1]);
    text += line.slice(last, index);
    last = index + m[0].length;
    if (chord) chords.push({ at: text.length, label: chord, text: m[1] });
    else text += m[0];
  }
  text += line.slice(last);
  return { text, chords };
}

function looksLikeChordPro(lines: string[]): boolean {
  if (lines.some((line) => DIRECTIVE.test(line))) return true;
  let inline = 0;
  for (const line of lines) for (const m of line.matchAll(INLINE_CHORD)) if (label(m[1])) inline++;
  return inline >= 2;
}

/** Copies a section's lines where a heading stands alone («Припев.» = sing the chorus again). */
function expandRepeats(blocks: { section: string | null; lines: LyricLine[] }[]): LyricLine[] {
  const firstOf = new Map<string, LyricLine[]>();
  const out: LyricLine[] = [];
  for (const block of blocks) {
    let lines = block.lines;
    if (block.section && !lines.length) {
      lines = (firstOf.get(sectionBase(block.section)) ?? []).map((line) => ({ ...line, section: block.section }));
    } else if (block.section && !firstOf.has(sectionBase(block.section))) {
      firstOf.set(sectionBase(block.section), lines);
    }
    out.push(...lines);
  }
  return out;
}

/** The pasted or imported text → lines with chords. Never throws; garbage gives plain lines. */
export function parseLyrics(text: string): LyricDoc {
  let lines = cleanLines(text);
  let capo = 0;
  lines = lines.filter((line) => {
    const value = capoOf(line);
    if (value === null) return true;
    capo = value;
    return false;
  });
  // A songbook that writes H for B (amdm.ru, German books): its B is B♭.
  const germanB = usesGermanB(lines);

  if (lines.filter((line) => LRC_LINE.test(line)).length >= 3) {
    return { lines: parseLrc(lines), capo, format: 'lrc' };
  }

  const chordPro = looksLikeChordPro(lines);
  const blocks: { section: string | null; lines: LyricLine[] }[] = [{ section: null, lines: [] }];
  const add = (line: Omit<LyricLine, 'section' | 'time'>) =>
    blocks[blocks.length - 1].lines.push({ ...line, time: null, section: blocks[blocks.length - 1].section });
  const startSection = (name: string) => blocks.push({ section: sectionName(name), lines: [] });
  let sawChords = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || LRC_TAG.test(line)) continue;

    if (chordPro) {
      const directive = DIRECTIVE.exec(line);
      if (directive) {
        const [, name, value = ''] = directive;
        const key = name.toLowerCase();
        if (key === 'capo') capo = Number(value) || capo;
        // A section ChordPro leaves unnamed is named in the current language.
        else if (key === 'soc' || key === 'start_of_chorus') startSection(value || L().sections.chorus);
        else if (key === 'sov' || key === 'start_of_verse') startSection(value || L().sections.verse);
        else if (key === 'sob' || key === 'start_of_bridge') startSection(value || L().sections.bridge);
        else if ((key === 'c' || key === 'comment' || key === 'ci') && HEADING.test(value)) {
          startSection(HEADING.exec(value)![1]);
        } else if (key.startsWith('eo')) blocks.push({ section: null, lines: [] });
        continue;
      }
    }

    const heading = HEADING.exec(line);
    if (heading && (!heading[2] || isChordLine(heading[2]))) {
      startSection(heading[1]);
      if (heading[2]) {
        // «Вступление: Am F C G» — a heading with the chords of an instrumental part
        const offset = line.length - heading[2].length;
        add({ text: '', chords: chordColumns(heading[2], germanB).map((c) => ({ at: c.at + offset, label: chordLabel(c.chord), text: c.text })) });
        sawChords = true;
      }
      continue;
    }

    if (chordPro) {
      const parsed = chordProLine(line);
      if (parsed.chords.length) sawChords = true;
      add({ text: parsed.text.trim() ? parsed.text.trimEnd() : '', chords: parsed.chords });
      continue;
    }

    if (isChordLine(line)) {
      sawChords = true;
      const chords = chordColumns(line, germanB).map((c) => ({ at: c.at, label: chordLabel(c.chord), text: c.text }));
      const next = lines[i + 1];
      const nextHeading = next !== undefined ? HEADING.exec(next) : null;
      if (next !== undefined && next.trim() && !isChordLine(next) && !(nextHeading && (!nextHeading[2] || isChordLine(nextHeading[2])))) {
        add({ text: next, chords: chords.map((c) => ({ ...c, at: Math.min(c.at, next.length) })) });
        i++;
      } else {
        add({ text: '', chords });
      }
      continue;
    }

    add({ text: line, chords: [] });
  }

  const format: LyricFormat = chordPro ? 'chordpro' : sawChords ? 'chords-over' : 'plain';
  return { lines: expandRepeats(blocks), capo, format };
}

/** The doc's chords moved by `semitones` (labels stay in the service's notation). */
export function transposeDoc(doc: LyricDoc, semitones: number): LyricDoc {
  if (!semitones) return doc;
  return {
    ...doc,
    lines: doc.lines.map((line) => ({
      ...line,
      chords: line.chords.map((c) => {
        const chord = parseChord(c.label);
        return chord ? { ...c, label: chordLabel(transposeChord(chord, semitones)) } : c;
      }),
    })),
  };
}

/** Chords as they sound: the text's capo applied (its chords are shapes played with it). */
export function withCapo(doc: LyricDoc): LyricDoc {
  return doc.capo ? { ...transposeDoc(doc, doc.capo), capo: 0 } : doc;
}
