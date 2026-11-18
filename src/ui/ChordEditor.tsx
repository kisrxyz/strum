import { useState } from 'react';
import { useLang } from '../i18n/useLang';
import { noteName, QUALITIES, type Quality } from '../music/chords';
import { shapeSpelling } from '../music/display';
import { chordAt, effectiveChords, mergeWithPrevious, setChord, splitAt } from '../music/track';
import { editableShape, labelFromShape, shapeName, viewOptions } from '../song/chordView';
import { fmtTime } from '../song/format';
import { songPlayer } from '../song/player';
import type { Analysis, ChordSegment, Song } from '../song/types';
import { useSong } from '../state/song';

/** The quality's button: a chord symbol, except the plain major chord, which has a word (`major`). */
const QUALITY_TEXT: Record<Exclude<Quality, 'maj'>, string> = {
  min: 'm',
  '7': '7',
  min7: 'm7',
  maj7: 'maj7',
  sus4: 'sus4',
  sus2: 'sus2',
  dim: 'dim',
  aug: 'aug',
  maj6: '6',
  min6: 'm6',
  dim7: 'dim7',
  hdim7: 'm7♭5',
  minmaj7: 'm(maj7)',
};

/** Correcting one chord of the lane: a row under it, no pop-up. Names are the shapes you play. */
export function ChordEditor({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const e = t.songUi.chordEditor;
  const editIndex = useSong((s) => s.editIndex);
  const [resetUntil, setResetUntil] = useState(0);
  if (editIndex === null) return null;
  const track = effectiveChords(song, analysis);
  const seg = track[editIndex];
  if (!seg) return null;

  const o = viewOptions(song);
  const shape = editableShape(seg.chord, o);
  const spelling = shapeSpelling(analysis?.key ?? null, o);
  const select = (next: ChordSegment[], at: number) =>
    useSong.getState().patch({ editIndex: Math.max(0, chordAt(next, at)) });
  const save = (next: ChordSegment[], at: number) => {
    useSong.getState().updateSong({ chords: next });
    select(next, at);
  };
  const pick = (root: number, quality: Quality) =>
    save(setChord(track, editIndex, labelFromShape({ root, quality }, o)), seg.start + 0.001);
  /** Where to cut: the playhead if it is inside the chord now, else its middle. */
  const cutAt = () => {
    const pos = songPlayer.position();
    return pos > seg.start && pos < seg.end ? pos : (seg.start + seg.end) / 2;
  };

  return (
    <section className="editor" aria-label={e.label}>
      <div className="panel-head">
        <span className="panel-head__title">{e.label}</span>
        <span className="editor__what num">
          {shapeName(seg.chord, song, analysis)} · {fmtTime(seg.start)}–{fmtTime(seg.end)}
        </span>
        <button type="button" className="btn btn--sm btn--ghost" disabled={editIndex === 0} onClick={() => select(track, track[editIndex - 1].start + 0.001)}>
          {t.songUi.prevItem}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={editIndex >= track.length - 1}
          onClick={() => select(track, track[editIndex + 1].start + 0.001)}
        >
          {t.songUi.nextItem}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => save(splitAt(track, cutAt(), analysis?.beats ?? []), seg.start + 0.001)}>
          {e.split}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={editIndex === 0}
          onClick={() => save(mergeWithPrevious(track, editIndex), seg.start - 0.001)}
        >
          {e.merge}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => save(setChord(track, editIndex, 'N'), seg.start + 0.001)}>
          {e.noChord}
        </button>
        {song.chords && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              if (Date.now() > resetUntil) {
                setResetUntil(Date.now() + 4000);
                return;
              }
              useSong.getState().updateSong({ chords: null });
              useSong.getState().patch({ editIndex: null });
            }}
          >
            {Date.now() < resetUntil ? e.restoreAll : t.songUi.restore}
          </button>
        )}
        <button type="button" className="btn btn--sm btn--primary" onClick={() => useSong.getState().patch({ editIndex: null })}>
          {t.common.done}
        </button>
      </div>
      <div className="editor__body">
      <div className="editor__row" role="group" aria-label={e.root}>
        {Array.from({ length: 12 }, (_, pc) => (
          <button
            type="button"
            key={pc}
            className={`keybtn keybtn--root${shape?.root === pc ? ' is-on' : ''}`}
            onClick={() => pick(pc, shape?.quality ?? 'maj')}
          >
            {noteName(pc, spelling)}
          </button>
        ))}
      </div>
      <div className="editor__row" role="group" aria-label={e.type}>
        {QUALITIES.map((q) => (
          <button
            type="button"
            key={q}
            className={`keybtn${shape?.quality === q ? ' is-on' : ''}`}
            onClick={() => pick(shape?.root ?? 0, q)}
          >
            {q === 'maj' ? e.major : QUALITY_TEXT[q]}
          </button>
        ))}
      </div>
      </div>
    </section>
  );
}
