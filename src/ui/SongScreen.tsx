import { AudioLines, SlidersHorizontal, WifiOff } from 'lucide-react';
import { APP_NAME, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { keyName, keySpelling } from '../music/keys';
import { TUNINGS } from '../music/tunings';
import { songActions } from '../song/actions';
import { isTabSong, type Analysis, type Song, type SongView } from '../song/types';
import { useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { AddSongButton } from './AddSongButton';
import { ChordChart } from './ChordChart';
import { ChordEditor } from './ChordEditor';
import { soundingKey } from './Fretboard';
import { LazyTabPanel } from './LazyTabPanel';
import { LyricsEditor } from './LyricsEditor';
import { LyricsPanel } from './LyricsPanel';
import { Mixer, separationText } from './Mixer';
import { NeckPanel } from './NeckPanel';
import { NoteEditor } from './NoteEditor';
import { NotesLane } from './NotesLane';
import { PrintLyrics } from './PrintLyrics';
import { SongOptions } from './SongOptions';
import { Transport } from './Transport';
import { useCapoHint } from './useCapoHint';
import { Waveform } from './Waveform';

const VIEWS: SongView[] = ['chords', 'lyrics', 'tab', 'notes'];

/**
 * The strip on top of the player: the song, what is shown under the timeline (W steps through the
 * views), the song's tempo and key with what is set for it (capo, tuning), and the options panel.
 */
function PlayerHead({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const u = t.songUi;
  const state = useSong((s) => s.state);
  const optionsOpen = useRuntime((s) => s.songSettings);
  const capoHint = useCapoHint(song, analysis);
  const p = song.player;
  const key = soundingKey(analysis, song);
  const stems = separationText(song);
  const busy = state === 'loading' ? t.common.loading : stems?.tone === 'busy' ? stems.text : null;

  return (
    <header className="phead">
      <div className="phead__song">
        <span className="phead__title">{song.title}</span>
        {song.artist && <span className="phead__artist">{song.artist}</span>}
      </div>
      <div className="seg phead__views" role="tablist" aria-label={u.view} title={withKey(u.nextView, 'W')}>
        {VIEWS.map((v) => (
          <button key={v} type="button" role="tab" aria-current={v === p.view} onClick={() => useSong.getState().updatePlayer({ view: v })}>
            {u.views[v]}
          </button>
        ))}
      </div>
      <div className="phead__facts">
        {busy && <span className="phead__busy">{busy}</span>}
        {stems?.tone === 'error' && <span className="phead__busy phead__busy--cold">{stems.text}</span>}
        {p.capo > 0 ? (
          <button type="button" className="tag tag--on" title={withKey(u.capo, '[ ]')} onClick={() => songActions.stepCapo(1)}>
            {u.transport.capoOn(p.capo)}
          </button>
        ) : (
          capoHint && (
            <button type="button" className="tag" title={withKey(u.capo, ']')} onClick={() => songActions.stepCapo(1)}>
              {u.transport.capoEasier(capoHint.capo)}
            </button>
          )
        )}
        {p.tuning !== 'standard' && (
          <button type="button" className="tag tag--on" title={withKey(u.tuning, 'U')} onClick={() => songActions.nextTuning()}>
            {TUNINGS[p.tuning].name}
          </button>
        )}
        {analysis?.tempo ? (
          <span className="phead__fact" title={t.library.tempo}>
            <b className="num">{Math.round(analysis.tempo * p.speed)}</b> BPM
          </span>
        ) : null}
        {key && (
          <span className="phead__fact" title={t.library.key}>
            <b className="num">{keyName(key, keySpelling(key))}</b>
          </span>
        )}
        <button type="button" className="btn btn--ghost" aria-pressed={optionsOpen} title={u.transport.settingsTip} onClick={() => songActions.toggleSettings()}>
          <SlidersHorizontal size={16} />
          {u.settings}
        </button>
      </div>
    </header>
  );
}

function Offline() {
  const t = useLang();
  return (
    <main className="player player--empty">
      <div className="empty">
        <WifiOff size={36} />
        <h1 className="empty__title">{t.songUi.offline.title}</h1>
        <p className="empty__text">{t.songUi.offline.text(APP_NAME)}</p>
      </div>
    </main>
  );
}

function Empty({ hasSongs }: { hasSongs: boolean }) {
  const t = useLang();
  const e = t.songUi.empty;
  return (
    <main className="player player--empty">
      <div className="empty">
        <AudioLines size={36} />
        <h1 className="empty__title">{hasSongs ? e.pickTitle : e.addTitle}</h1>
        <p className="empty__text">{hasSongs ? e.pickText : e.addText}</p>
        <div className="empty__actions">
          {hasSongs && (
            <button type="button" className="btn btn--primary btn--lg" title={withKey(t.shell.screens.library, 'L')} onClick={() => useRuntime.getState().patch({ view: 'library' })}>
              {e.openSongs}
            </button>
          )}
          <AddSongButton primary={!hasSongs} />
        </div>
      </div>
    </main>
  );
}

/**
 * The player, for playing at the laptop: the song on top, its timeline, then the biggest place
 * for what you read while playing (chords, lyrics, tab or notes), one optional panel under it (the
 * neck, the mixer or an editor), the options on the right when open, and the transport below.
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
  const optionsOpen = useRuntime((s) => s.songSettings);
  const neckShown = useSettings((s) => (song ? s.neckShown[song.player.view] : false));
  // While «Сцена» is open the tab is drawn there (one alphaTab at a time).
  const stage = useRuntime((s) => s.stage);

  if (service === 'offline') return <Offline />;
  if (!song) return <Empty hasSongs={hasSongs} />;

  const view = song.player.view;
  const editingNote = view === 'notes' && noteEdit !== null;
  // One panel at a time under the view: an editor first, then what was opened by hand.
  const dock = editingLyrics ? (
    <LyricsEditor song={song} />
  ) : editingNote ? (
    <NoteEditor song={song} analysis={analysis} />
  ) : editing ? (
    <ChordEditor song={song} analysis={analysis} />
  ) : mixerOpen ? (
    <Mixer song={song} onClose={() => useSong.getState().patch({ mixerOpen: false })} />
  ) : neckShown ? (
    <NeckPanel song={song} analysis={analysis} />
  ) : null;

  return (
    <main className={`player player--${view}${isTabSong(song) ? ' player--tabsong' : ''}`}>
      <PlayerHead song={song} analysis={analysis} />
      <Waveform song={song} />
      <div className="player__body">
        <div className="player__stage">
          <div className="player__view">
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
          {dock && <div className="dock">{dock}</div>}
        </div>
        {optionsOpen && <SongOptions song={song} />}
      </div>
      <Transport song={song} analysis={analysis} />
      <PrintLyrics song={song} analysis={analysis} />
    </main>
  );
}
