import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect } from 'react';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { openStrings, soundingChord } from '../music/display';
import { expectedAt } from '../music/match';
import { effectiveNotes } from '../music/notes';
import { effectiveChords, visibility } from '../music/track';
import { TUNINGS } from '../music/tunings';
import { voicings } from '../music/voicings';
import { songActions } from '../song/actions';
import { shapeName, viewOptions } from '../song/chordView';
import { songPlayer } from '../song/player';
import { isTabSong, type Analysis, type Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import { NECK_VIEWS, useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { Fretboard } from './Fretboard';
import { useCurrentChord, useCurrentNote } from './useCurrentChord';

const NO_NOTES: never[] = [];

/**
 * The neck under the view (F): the current chord's fingering with its fingers (V: another one),
 * all its notes or the scale; with a tab running, the tab's notes; in Notes, the recording's note.
 * What you play glows on it.
 */
export function NeckPanel({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const u = t.songUi;
  const track = effectiveChords(song, analysis);
  const index = useCurrentChord(track);
  const voicing = useSong((s) => s.voicing);
  const neckView = useSettings((s) => s.neckView);
  const setNeckView = useSettings((s) => s.setNeckView);
  // The index is from the last frame: right after another song opens (or new chords arrive) it can
  // point past the new track until the next frame. Out of range must not crash the whole screen.
  const label = track[index]?.chord ?? 'N';
  useEffect(() => {
    useSong.getState().patch({ voicing: 0 });
  }, [label]);
  const tabNotes = useRuntime((s) => s.tabNotes);
  const showTab = song.player.view === 'tab' && song.tab !== null;
  const showNotes = song.player.view === 'notes';
  const notes = effectiveNotes(song, analysis);
  const current = useCurrentNote(showNotes ? notes : NO_NOTES);
  const shift = song.player.semitones;
  const midiOf = (i: number) => (i >= 0 && notes[i] ? notes[i].midi + shift : null);
  const strings = TUNINGS[song.player.tuning].strings;
  const expected = showNotes
    ? (now: number) => expectedAt(notes, songPlayer.position(now), shift)
    : showTab
      ? () => (useRuntime.getState().tabNotes?.now ?? []).map((p) => strings[p.string] + p.fret)
      : null;
  const visible = visibility(song.player.mode, song.player.reveal);
  const o = viewOptions(song);
  const chord = soundingChord(label, o);
  const shapes = chord && visible.fingerings ? voicings(chord, openStrings(o)).length : 0;
  const lead = showTab || showNotes;
  const step = (dir: number) => useSong.getState().patch({ voicing: (((voicing + dir) % shapes) + shapes) % shapes });

  return (
    <section className="neck" aria-label={u.fretboard}>
      <div className="neck__side">
        {lead ? (
          <span className="neck__caption">{showTab ? u.neck.tabNotes : isTabSong(song) ? u.neck.tabNote : u.neck.recordingNote}</span>
        ) : (
          <>
            <span className="neck__name num">{chord && visible.currentName ? shapeName(label, song, analysis) : '–'}</span>
            {shapes > 1 && neckView === 'shape' && (
              <span className="neck__shapes">
                <button type="button" className="iconbtn iconbtn--sm" aria-label={u.neck.prevFingering} onClick={() => step(-1)}>
                  <ChevronLeft size={14} />
                </button>
                <span className="num" title={u.neck.fingeringOf((voicing % shapes) + 1, shapes)}>
                  {(voicing % shapes) + 1}/{shapes}
                </span>
                <button type="button" className="iconbtn iconbtn--sm" aria-label={u.neck.nextFingering} title={withKey(u.neck.nextFingering, 'V')} onClick={() => step(1)}>
                  <ChevronRight size={14} />
                </button>
              </span>
            )}
            <div className="seg seg--sm neck__views" role="radiogroup" aria-label={u.options.neckShows} title={withKey(u.options.neckShows, 'Shift+F')}>
              {NECK_VIEWS.map((v) => (
                <button key={v} type="button" role="radio" aria-checked={v === neckView} onClick={() => setNeckView(v)}>
                  {u.neckShort[v]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <Fretboard
        song={song}
        analysis={analysis}
        label={label}
        tabNotes={showTab ? (tabNotes ?? { now: [], next: [] }) : null}
        noteMarks={showNotes ? { now: midiOf(current.now), next: midiOf(current.next) } : null}
        expected={expected}
      />
      <button type="button" className="iconbtn iconbtn--sm neck__close" aria-label={t.common.close} title={withKey(u.transport.hideNeck, 'F')} onClick={() => songActions.toggleNeck()}>
        <X size={14} />
      </button>
    </section>
  );
}
