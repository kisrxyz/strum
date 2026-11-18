import { useLang } from '../i18n/useLang';
import { songLyrics } from '../lyrics/songLyrics';
import { shapeName } from '../song/chordView';
import type { Analysis, Song } from '../song/types';
import { useSong } from '../state/song';

/**
 * The lyrics with their chords over the words, for the printer (or a PDF): hidden on screen,
 * the only thing on the page when printing (`@media print`). Chords as you play them.
 */
export function PrintLyrics({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const words = useSong((s) => s.words);
  const lyrics = songLyrics(song, analysis, words);
  if (!lyrics) return null;
  let section: string | null = null;
  return (
    <article className="print-lyrics" aria-hidden="true">
      <h1>{song.title}</h1>
      {song.artist && <p className="print-lyrics__artist">{song.artist}</p>}
      {song.player.capo > 0 && <p className="print-lyrics__artist">{t.songUi.printout.capo(song.player.capo)}</p>}
      {lyrics.doc.lines.map((line, i) => {
        const heading = line.section !== section && line.section ? <h2>{line.section}</h2> : null;
        section = line.section;
        const chords = [...line.chords].sort((a, b) => a.at - b.at);
        const cuts = [0, ...chords.map((c) => c.at), line.text.length];
        return (
          <div key={i}>
            {heading}
            <div className="print-lyrics__line">
              {cuts.slice(0, -1).map((from, k) => {
                const chord = k > 0 ? chords[k - 1] : null;
                const text = line.text.slice(from, cuts[k + 1]);
                if (!chord && !text) return null;
                return (
                  <span key={k} className="print-lyrics__piece">
                    <b>{chord ? shapeName(chord.label, song, analysis) : ' '}</b>
                    <span>{text || ' '}</span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </article>
  );
}
