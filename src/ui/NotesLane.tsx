import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n/useLang';
import { noteName } from '../music/chords';
import { shapePitchClass, shapeSpelling } from '../music/display';
import { effectiveNotes, nextNote, noteAt, noteRange, phraseAt, phrases } from '../music/notes';
import { viewOptions } from '../song/chordView';
import { funActions } from '../song/funActions';
import { songBars } from '../song/grid';
import { songPlayer } from '../song/player';
import { notesMissing } from '../song/textActions';
import type { Analysis, Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { LaneBars } from './LaneBars';
import { useEngineFrame } from './useEngineFrame';
import { useLaneGlide } from './useLaneGlide';

/** Seconds visible at once: a sixteenth at 120 BPM is still wide enough for its name. */
const WINDOW_SECONDS = 5;
/** The playhead sits this far into the lane. */
const LEAD = 0.22;

interface LaneNoteProps {
  index: number;
  left: number;
  width: number;
  /** 0 = the top of the range, 1 = its bottom. */
  place: number;
  text: string;
  now: boolean;
  editing: boolean;
  /** The tooltip («Поправить ноту»). */
  title: string;
}

/** One note of the lane. Memoised: when the note changes, only the old and the new one re-render. */
const LaneNote = memo(function LaneNote({ index, left, width, place, text, now, editing, title }: LaneNoteProps) {
  return (
    <button
      type="button"
      className={`notes__note${now ? ' notes__note--now' : ''}${editing ? ' notes__note--edit' : ''}`}
      // Every note is as tall as its name; the rows above stay free for the bar and phrase numbers.
      style={{ left: `${left}px`, width: `${width}px`, top: `calc(1.3rem + (100% - 1.3rem - 1.5rem - 4px) * ${place.toFixed(4)})` }}
      title={title}
      onClick={() => funActions.openNoteEditor(index)}
    >
      {text}
    </button>
  );
});

/**
 * «Ноты» (W): the notes of the guitar in the recording running past the playhead, higher notes
 * higher, each with its name; the phrases as bands. The current note big on the left, the next one
 * under it. A click on a note opens its editor in the fretboard's place.
 */
export function NotesLane({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const laneEl = useRef<HTMLDivElement>(null);
  const stripEl = useRef<HTMLDivElement>(null);
  const currentRef = useRef(-1);
  const aheadRef = useRef(-1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(-1);
  const [ahead, setAhead] = useState(-1);
  const editing = useRuntime((s) => s.noteEdit);
  const move = useLaneGlide();

  const notes = effectiveNotes(song, analysis);
  const list = useMemo(() => phrases(notes), [notes]);
  const range = noteRange(notes);
  const bars = songBars(song, analysis);
  const windowSeconds = WINDOW_SECONDS;
  const pps = width > 0 ? width / windowSeconds : 0;

  useEffect(() => {
    const el = laneEl.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [notes.length > 0]);

  useEngineFrame((_, now) => {
    const { pos, rate, until } = useSong.getState().state === 'ready' ? songPlayer.motion(now) : { pos: 0, rate: 0, until: 0 };
    const strip = stripEl.current;
    if (strip && pps) move(strip, (t) => (windowSeconds * LEAD - t) * pps, pps, now, pos, rate, until);
    const index = noteAt(notes, pos);
    if (index !== currentRef.current) {
      currentRef.current = index;
      setCurrent(index);
    }
    const next = nextNote(notes, pos);
    if (next !== aheadRef.current) {
      aheadRef.current = next;
      setAhead(next);
    }
  });

  // Names as the shapes are named (capo, tuning), moved with the song's pitch.
  const o = viewOptions(song);
  const spelling = shapeSpelling(analysis?.key ?? null, o);
  const names = useMemo(
    () => notes.map((n) => noteName(shapePitchClass(n.midi + song.player.semitones, o), spelling)),
    // o is rebuilt each render; what it depends on is listed
    [notes, song.player.semitones, song.player.capo, song.player.tuning, spelling],
  );
  const phraseNow = phraseAt(list, current >= 0 ? notes[current].start : -1);

  // Higher notes higher, within the usual range (stray notes sit on its edges).
  const low = range?.low ?? 60;
  const span = Math.max(1, (range?.high ?? 72) - low);
  const place = (midi: number) => 1 - Math.min(1, Math.max(0, (midi - low) / span));

  return (
    <section className="chords notes" aria-label={t.songUi.notes.label}>
      <div className="chords__now notes__now">
        <span className="chords__name">{current >= 0 ? names[current] : '—'}</span>
        <span className="chords__next">
          {ahead >= 0 ? t.songUi.next(names[ahead]) : ' '}
          {list.length > 0 && (
            <span className="notes__phrase-no">{phraseNow >= 0 ? ` · ${t.songUi.notes.phraseOf(phraseNow + 1, list.length)}` : ''}</span>
          )}
        </span>
      </div>
      <div ref={laneEl} className="lane notes__lane">
        {!notes.length ? (
          <p className="lane__empty">{notesMissing(song)}</p>
        ) : (
          <div ref={stripEl} className="lane__strip" style={{ width: `${Math.ceil(song.duration * pps)}px` }}>
            <LaneBars bars={bars} pps={pps} />
            {list.map((p, i) => (
              <span
                key={`p${p.start}`}
                className={`notes__band${i === phraseNow ? ' notes__band--now' : ''}`}
                style={{ left: `${p.start * pps}px`, width: `${Math.max(2, (p.end - p.start) * pps)}px` }}
              >
                {i + 1}
              </span>
            ))}
            {notes.map((n, i) => (
              <LaneNote
                key={`n${n.start}-${i}`}
                index={i}
                left={n.start * pps}
                width={Math.max(3, (n.end - n.start) * pps - 1)}
                place={place(n.midi)}
                text={names[i]}
                now={i === current}
                editing={i === editing}
                title={t.songUi.notes.editNote}
              />
            ))}
          </div>
        )}
        <span className="lane__playhead" style={{ left: `${LEAD * 100}%` }} aria-hidden="true" />
      </div>
    </section>
  );
}
