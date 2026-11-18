import { FileText, Pencil } from 'lucide-react';
import { memo, useRef, useState, type CSSProperties } from 'react';
import { useLang } from '../i18n/useLang';
import { lineAt, type TimedLine } from '../lyrics/align';
import type { LyricLine } from '../lyrics/parse';
import { songLyrics } from '../lyrics/songLyrics';
import { effectiveChords, visibility, type Visible } from '../music/track';
import { shapeName } from '../song/chordView';
import { songPlayer } from '../song/player';
import { textActions } from '../song/textActions';
import { isTabSong, type Analysis, type Song } from '../song/types';
import { useSong } from '../state/song';
import { useCurrentChord } from './useCurrentChord';
import { useEngineFrame } from './useEngineFrame';

/** Lines shown after the one being sung (the box clips what does not fit). */
const NEXT_LINES = 5;
/** Further than this from a sung line, the panel shows the chord playing instead («проигрыш»). */
const GAP_SECONDS = 1.2;

interface Piece {
  chord: string | null;
  /** Index of the chord in the line (to light the one that sounds now). */
  index: number;
  text: string;
}

/** The line cut at its chords: each piece starts with the chord written over its first letter. */
function pieces(line: LyricLine): Piece[] {
  const chords = [...line.chords].sort((a, b) => a.at - b.at);
  if (!line.text) return chords.map((c, index) => ({ chord: c.label, index, text: '' }));
  const out: Piece[] = [];
  if (!chords.length || chords[0].at > 0) out.push({ chord: null, index: -1, text: line.text.slice(0, chords[0]?.at ?? line.text.length) });
  chords.forEach((c, index) => {
    const end = chords[index + 1]?.at ?? line.text.length;
    out.push({ chord: c.label, index, text: line.text.slice(c.at, end) });
  });
  return out;
}

interface LineProps {
  line: LyricLine;
  /** Index of the chord sounding now in this line, −1 for none. */
  nowChord: number;
  kind: 'prev' | 'now' | 'next';
  /** The section's name in the left column («Припев»), or null. */
  section: string | null;
  visible: Visible;
  name: (label: string) => string;
  /** The word shown on a line that has chords only («проигрыш»). */
  bare: string;
}

/** One line with its chords over the words; memoised so a frame re-renders only what changed. */
const Line = memo(function Line({ line, nowChord, kind, section, visible, name, bare }: LineProps) {
  const list = pieces(line);
  return (
    <div className={`lyr__row lyr__row--${kind}`}>
      <span className="lyr__section">{section ?? ''}</span>
      {/* --chars lets a long line shrink its font to fit the box (container units), never wrap. */}
      <div
        className={`lyr__line${line.text ? '' : ' lyr__line--bare'}`}
        style={{ '--chars': Math.max(14, line.text.length + line.chords.length) } as CSSProperties}
      >
        {list.map((piece, i) => {
          const now = piece.index === nowChord && piece.chord !== null;
          const past = nowChord >= 0 && piece.chord !== null && piece.index < nowChord;
          const shown = piece.chord !== null && (visible.allNames || (visible.currentName && now));
          return (
            <span key={i} className="lyr__piece">
              {piece.chord !== null && (
                <span className={`lyr__chord${now ? ' is-now' : past ? ' is-past' : ''}`}>
                  {shown ? name(piece.chord) : visible.changes ? '•' : ''}
                </span>
              )}
              <span className="lyr__text">{piece.text || ' '}</span>
            </span>
          );
        })}
        {!line.text && <span className="lyr__text lyr__bare">{bare}</span>}
      </div>
    </div>
  );
});

/** Which chord of the timed line sounds at `t` (−1 before its first one). */
function chordIndex(line: TimedLine | undefined, t: number): number {
  if (!line) return -1;
  let found = -1;
  line.chords.forEach((c, i) => {
    if (c.time <= t) found = i;
  });
  return found;
}

/** Between sung lines: no line is «now», the chord playing is. */
function inGap(lines: TimedLine[], line: number, t: number): boolean {
  const cur = lines[line];
  const next = lines[line + 1];
  if (!cur) return !next || next.start - t > GAP_SECONDS;
  return t > cur.end + GAP_SECONDS && (!next || next.start - t > GAP_SECONDS);
}

/**
 * «Текст»: the line being sung big with its chords over the words (the one sounding now warm),
 * the line before it faint, the next ones smaller under it, the part of the song on the left.
 * Between sung lines the chord playing and the next one stand in the line's place. Without timing
 * the first lines stand still with a word on why.
 */
export function LyricsPanel({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const l = t.songUi.lyrics;
  const words = useSong((s) => s.words);
  const lyrics = songLyrics(song, analysis, words);
  const [at, setAt] = useState({ line: -1, chord: -1, gap: false });
  const last = useRef(at);
  const visible = visibility(song.player.mode, song.player.reveal);
  const name = (label: string) => shapeName(label, song, analysis);
  const track = effectiveChords(song, analysis);
  const current = useCurrentChord(track);

  useEngineFrame((_, now) => {
    const lines = lyrics?.lines;
    if (!lines) return;
    const pos = useSong.getState().state === 'ready' ? songPlayer.position(now) : 0;
    const line = lineAt(lines, pos);
    const chord = chordIndex(lines[line], pos);
    const gap = inGap(lines, line, pos);
    if (line !== last.current.line || chord !== last.current.chord || gap !== last.current.gap) {
      last.current = { line, chord, gap };
      setAt(last.current);
    }
  });

  if (!lyrics) {
    return (
      <div className="empty">
        <FileText size={36} />
        <h2 className="empty__title">{l.emptyTitle}</h2>
        <p className="empty__text">{l.emptyText}</p>
        <div className="empty__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={() => useSong.getState().patch({ editingLyrics: true })}>
            {l.add}
          </button>
          <button type="button" className="btn btn--lg" onClick={() => void textActions.findOnline()}>
            {t.songUi.lyricsEditor.findOnline}
          </button>
        </div>
      </div>
    );
  }

  const { doc, lines } = lyrics;
  const order = lines ? lines.map((l) => l.line) : doc.lines.map((_, i) => i);
  const at0 = lines ? Math.max(0, at.line) : 0;
  const gap = Boolean(lines) && at.gap;
  const sectionOf = (i: number) => doc.lines[order[i]]?.section ?? null;
  // In a gap the next sung line comes first under the chord.
  const firstNext = gap && at.line >= 0 ? at0 + 1 : gap ? 0 : at0 + 1;
  const next = Array.from({ length: NEXT_LINES }, (_, k) => firstNext + k).filter((i) => i < order.length);
  const transcript = song.transcript;
  const note = lines
    ? null
    : transcript?.status === 'queued' || transcript?.status === 'running'
      ? l.transcribing(transcript.progress ? Math.round(transcript.progress * 100) : null)
      : song.activeModel
        ? l.timeWhenHeard
        : isTabSong(song)
          ? l.tabNoVoice
          : l.noStems;
  const shift = lyrics.shift > 0 ? `+${lyrics.shift}` : `−${-lyrics.shift}`;
  const chordName = (i: number) => (i >= 0 && i < track.length && track[i].chord !== 'N' ? shapeName(track[i].chord, song, analysis) : '—');
  const nextChord = track.findIndex((c, i) => i > current && c.chord !== 'N' && c.chord !== track[current]?.chord);

  return (
    <div className="lyr">
      <div className="view-tools">
        {lyrics.shift !== 0 && (
          <button type="button" className="btn btn--sm btn--ghost" title={l.shiftTip(shift)} onClick={() => textActions.toggleShift()}>
            {l.shiftButton(shift)}
          </button>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => useSong.getState().patch({ editingLyrics: true })}>
          <Pencil size={14} />
          {l.edit}
        </button>
      </div>
      {note && <p className="lyr__note">{note}</p>}
      <div className="lyr__lines">
        {!gap && at0 > 0 && lines ? (
          <Line key={`p${order[at0 - 1]}`} line={doc.lines[order[at0 - 1]]} nowChord={-1} kind="prev" section={null} visible={visible} name={name} bare={l.instrumental} />
        ) : (
          <div className="lyr__row lyr__row--prev" aria-hidden="true" />
        )}
        {gap ? (
          <div className="lyr__row lyr__row--now lyr__row--gap">
            <span className="lyr__section" />
            <div className="lyr__line">
              <span className="lyr__gapchord is-now">{visible.currentName ? chordName(current) : '?'}</span>
              {visible.allNames && nextChord >= 0 && <span className="lyr__gapnext">{t.songUi.next(chordName(nextChord))}</span>}
            </div>
          </div>
        ) : (
          <Line
            key={`n${order[at0]}`}
            line={doc.lines[order[at0]]}
            nowChord={lines ? at.chord : -1}
            kind="now"
            section={sectionOf(at0)}
            visible={visible}
            name={name}
            bare={l.instrumental}
          />
        )}
        {next.map((i) => (
          <Line
            key={order[i]}
            line={doc.lines[order[i]]}
            nowChord={-1}
            kind="next"
            section={sectionOf(i) !== sectionOf(i - 1) || (gap && i === firstNext) ? sectionOf(i) : null}
            visible={visible}
            name={name}
            bare={l.instrumental}
          />
        ))}
      </div>
    </div>
  );
}
