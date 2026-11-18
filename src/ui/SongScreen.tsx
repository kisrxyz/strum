import { useEffect } from 'react';
import { APP_NAME, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { openStrings, soundingChord } from '../music/display';
import { expectedAt } from '../music/match';
import { effectiveNotes } from '../music/notes';
import { effectiveChords, visibility } from '../music/track';
import { TUNINGS } from '../music/tunings';
import { voicings } from '../music/voicings';
import { shapeName, viewOptions } from '../song/chordView';
import { songPlayer } from '../song/player';
import { isTabSong, type Analysis, type Song, type SongView } from '../song/types';
import { useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { AddSongButton } from './AddSongButton';
import { ChordChart } from './ChordChart';
import { ChordEditor } from './ChordEditor';
import { Fretboard } from './Fretboard';
import { LazyTabPanel } from './LazyTabPanel';
import { LyricsEditor } from './LyricsEditor';
import { LyricsPanel } from './LyricsPanel';
import { Mixer } from './Mixer';
import { NoteEditor } from './NoteEditor';
import { NotesLane } from './NotesLane';
import { PrintLyrics } from './PrintLyrics';
import { SongSettings } from './SongSettings';
import { Transport } from './Transport';
import { useCurrentChord, useCurrentNote } from './useCurrentChord';
import { Waveform } from './Waveform';

const VIEWS: SongView[] = ['lyrics', 'chords', 'tab', 'notes'];

/** What runs under the wave: W steps through these. */
function ViewSwitch({ view }: { view: SongView }) {
  const t = useLang();
  return (
    <div className="song__views">
      <div className="seg" role="tablist" aria-label={t.songUi.view} title={withKey(t.songUi.nextView, 'W')}>
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-current={v === view}
            onClick={() => useSong.getState().updatePlayer({ view: v })}
          >
            {t.songUi.views[v]}
          </button>
        ))}
      </div>
    </div>
  );
}

const NO_NOTES: never[] = [];

/**
 * The neck in its own panel (F): the current chord's fingering with its fingers (V — another one),
 * or the tab's notes («Табы»), or the recording's note («Ноты»). What you play glows on it.
 */
function NeckPanel({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const track = effectiveChords(song, analysis);
  const index = useCurrentChord(track);
  const voicing = useSong((s) => s.voicing);
  const neckView = useSettings((s) => s.neckView);
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
  return (
    <section className="neck">
      <div className="neck__label">
        {lead ? (
          <span className="neck__caption">
            {showTab ? t.songUi.neck.tabNotes : isTabSong(song) ? t.songUi.neck.tabNote : t.songUi.neck.recordingNote}
          </span>
        ) : (
          <>
            <span className="neck__name num">{chord && visible.currentName ? shapeName(label, song, analysis) : '—'}</span>
            {shapes > 0 && neckView === 'shape' && (
              <span className="neck__caption" title={withKey(t.songUi.neck.nextFingering, 'V')}>
                {t.songUi.neck.fingeringOf((voicing % shapes) + 1, shapes)}
              </span>
            )}
            {neckView !== 'shape' && <span className="neck__caption">{t.songUi.neckViews[neckView]}</span>}
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
    </section>
  );
}

function Offline() {
  const t = useLang();
  return (
    <main className="song song--empty">
      <div className="song__message">
        <h1>{t.songUi.offline.title}</h1>
        <p>{t.songUi.offline.text(APP_NAME)}</p>
      </div>
    </main>
  );
}

function Empty({ hasSongs }: { hasSongs: boolean }) {
  const t = useLang();
  const e = t.songUi.empty;
  return (
    <main className="song song--empty">
      <div className="song__message">
        <h1>{hasSongs ? e.pickTitle : e.addTitle}</h1>
        <p>{hasSongs ? e.pickText : e.addText}</p>
        <AddSongButton />
      </div>
    </main>
  );
}

/**
 * «Песня», for playing at the laptop: the wave, then the biggest place for what you read while
 * playing (the lyrics, the chord chart, the tab or the notes — W), an optional panel in the neck's
 * place (the neck, «Дорожки», «Настройки» or an editor), and one row of controls at the bottom.
 */
export function SongScreen() {
  const service = useLibrary((s) => s.service);
  const hasSongs = useLibrary((s) => s.songs.length > 0);
  const song = useSong((s) => s.song);
  const analysis = useSong((s) => s.analysis);
  const editing = useSong((s) => s.editIndex !== null);
  const editingLyrics = useSong((s) => s.editingLyrics);
  const mixerOpen = useSong((s) => s.mixerOpen);
  const noteEdit = useRuntime((s) => s.noteEdit);
  const settingsOpen = useRuntime((s) => s.songSettings);
  const neckShown = useSettings((s) => (song ? s.neckShown[song.player.view] : false));
  // While «Сцена» is open the tab is drawn there (one alphaTab at a time).
  const stage = useRuntime((s) => s.stage);

  if (service === 'offline') return <Offline />;
  if (!song) return <Empty hasSongs={hasSongs} />;

  const view = song.player.view;
  const editingNote = view === 'notes' && noteEdit !== null;
  // One panel at a time in the neck's place: an editor first, then what was opened by hand.
  const panel = editingLyrics ? (
    <LyricsEditor song={song} />
  ) : editingNote ? (
    <NoteEditor song={song} analysis={analysis} />
  ) : editing ? null : mixerOpen ? (
    <Mixer song={song} onClose={() => useSong.getState().patch({ mixerOpen: false })} />
  ) : settingsOpen ? (
    <SongSettings song={song} />
  ) : neckShown ? (
    <NeckPanel song={song} analysis={analysis} />
  ) : null;
  return (
    <main className={`song song--${view}${panel || editing ? ' song--panel' : ''}`}>
      <Waveform song={song} />
      <div className="song__main">
        <ViewSwitch view={view} />
        {view === 'tab' ? (
          stage ? null : <LazyTabPanel song={song} analysis={analysis} />
        ) : view === 'notes' ? (
          <NotesLane song={song} analysis={analysis} />
        ) : view === 'lyrics' ? (
          <LyricsPanel song={song} analysis={analysis} />
        ) : (
          <ChordChart song={song} analysis={analysis} />
        )}
      </div>
      <ChordEditor song={song} analysis={analysis} />
      {panel && <div className="song__panel">{panel}</div>}
      <Transport song={song} analysis={analysis} />
      <PrintLyrics song={song} analysis={analysis} />
    </main>
  );
}
