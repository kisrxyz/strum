import { useState } from 'react';
import { useLang } from '../i18n/useLang';
import { noteName } from '../music/chords';
import { shapePitchClass, shapeSpelling } from '../music/display';
import { effectiveNotes } from '../music/notes';
import { viewOptions } from '../song/chordView';
import { fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { songPlayer } from '../song/player';
import type { Analysis, Song } from '../song/types';
import { useRuntime } from '../state/runtime';

/** Correcting one note of the «Ноты» lane: a row in the fretboard's place, no pop-up (decision 4). */
export function NoteEditor({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const e = t.songUi.noteEditor;
  const index = useRuntime((s) => s.noteEdit);
  const [resetUntil, setResetUntil] = useState(0);
  if (index === null) return null;
  const notes = effectiveNotes(song, analysis);
  const note = notes[index];
  if (!note) return null;
  const o = viewOptions(song);
  const name = noteName(shapePitchClass(note.midi + song.player.semitones, o), shapeSpelling(analysis?.key ?? null, o));
  const octave = Math.floor((note.midi + song.player.semitones) / 12) - 1;
  const go = (i: number) => {
    funActions.openNoteEditor(i);
    songPlayer.seek(Math.max(0, notes[i].start - 0.05));
  };

  return (
    <section className="chordedit" aria-label={e.label}>
      <div className="chordedit__head">
        <span className="chordedit__what">
          {name}
          <sub>{octave}</sub> · {fmtTime(note.start)} · {Math.round((note.end - note.start) * 1000)} {t.common.units.ms}
        </span>
        <button type="button" className="chordedit__act" disabled={index === 0} onClick={() => go(index - 1)}>
          {t.songUi.prevItem}
        </button>
        <button type="button" className="chordedit__act" disabled={index >= notes.length - 1} onClick={() => go(index + 1)}>
          {t.songUi.nextItem}
        </button>
        <button type="button" className="chordedit__act chordedit__done" onClick={() => funActions.openNoteEditor(null)}>
          {t.common.done}
        </button>
      </div>
      <div className="chordedit__row" role="group" aria-label={e.note}>
        <button type="button" className="chordedit__btn" onClick={() => funActions.editNote(index, 'down')}>
          {e.down}
        </button>
        <button type="button" className="chordedit__btn" onClick={() => funActions.editNote(index, 'up')}>
          {e.up}
        </button>
        <button type="button" className="chordedit__btn" onClick={() => funActions.editNote(index, 'remove')}>
          {e.remove}
        </button>
        {song.guitarNotes && (
          <button
            type="button"
            className="chordedit__btn"
            onClick={() => {
              if (Date.now() > resetUntil) {
                setResetUntil(Date.now() + 4000);
                return;
              }
              funActions.resetNotes();
            }}
          >
            {Date.now() < resetUntil ? e.restoreAll : t.songUi.restore}
          </button>
        )}
      </div>
    </section>
  );
}
