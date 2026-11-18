// A tab file → alphaTab's score. Imports alphaTab's core only: this runs in the tab-song worker
// too, and the package's main module would take over a worker's messages (initializeWorker).
import { importer, Settings, type model } from '@coderline/alphatab/core';

/** Guitar Pro 3–5 store texts in the system's code page; Russian files use Windows-1251. */
const CYRILLIC = 'windows-1251';

const isHigh = (ch: string) => {
  const code = ch.charCodeAt(0);
  return code >= 0xc0 && code <= 0xff;
};

/**
 * Texts read as Windows-1252 that are really Windows-1251: «Íåáî» for «Небо». cp1251's А–я are
 * bytes C0–FF, which cp1252 shows as À–ÿ. In such a word nearly every letter is one of those;
 * a Western word has one or two among plain letters («Café», «Über»). Plain-ASCII texts (track
 * names like «Solo») say nothing either way.
 */
export function looksLikeCyrillicMojibake(texts: string[]): boolean {
  let high = 0;
  let letters = 0;
  for (const text of texts) {
    for (const word of text.match(/\p{L}+/gu) ?? []) {
      const chars = [...word];
      const h = chars.filter(isHigh).length;
      if (!h) continue;
      high += h;
      letters += chars.length;
    }
  }
  return high >= 2 && high >= letters * 0.6;
}

function scoreTexts(score: model.Score): string[] {
  return [
    score.title,
    score.subTitle,
    score.artist,
    score.album,
    score.words,
    score.music,
    ...score.tracks.map((t) => t.name),
    ...score.masterBars.map((b) => b.section?.text ?? ''),
  ];
}

/**
 * Reads Guitar Pro (3–8), MusicXML or alphaTex. Throws alphaTab's error for a file it cannot read.
 * A Guitar Pro 3–5 file with Russian texts is read again in Windows-1251.
 */
export function readScore(bytes: Uint8Array, ext: string): model.Score {
  if (ext === 'alphatex') return importer.ScoreLoader.loadAlphaTex(new TextDecoder().decode(bytes), new Settings());
  const score = importer.ScoreLoader.loadScoreFromBytes(bytes, new Settings());
  if (!looksLikeCyrillicMojibake(scoreTexts(score))) return score;
  const settings = new Settings();
  settings.importer.gp3To5encoding = CYRILLIC;
  return importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
}
