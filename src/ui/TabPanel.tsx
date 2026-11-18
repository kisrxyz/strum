import { FileMusic, Printer, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { L, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { effectiveChords } from '../music/track';
import { songActions } from '../song/actions';
import { api } from '../song/api';
import { songBars } from '../song/grid';
import { songPlayer } from '../song/player';
import { TabGlue } from '../song/tabPlayer';
import { textActions } from '../song/textActions';
import { isTabSong, type Analysis, type Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { autoSync, syncTimes, type TabBar } from '../tab/sync';
import { shiftFret } from '../tab/transpose';
import { useEngineFrame } from './useEngineFrame';

/**
 * «Табы»: the song's tab in one long line, its cursor going with the recording at any speed.
 * The tab's bars are tied to the recording's bars (found by the chords and the tempos, moved by
 * «;» / Shift+«;»), the fretboard shows the notes at the cursor.
 */
export function TabPanel({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const scroller = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const glue = useRef<TabGlue | null>(null);
  const [bars, setBars] = useState<TabBar[]>([]);
  const [tempo, setTempo] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const tab = song.tab;
  const parts = useRuntime((s) => s.tabTracks);
  const playing = useSong((s) => s.playing);
  const shift = useRef({ semitones: 0, capo: 0 });
  shift.current = { semitones: song.player.semitones, capo: song.player.capo };

  // One alphaTab per tab file; a new file or another song starts afresh.
  useEffect(() => {
    if (!tab || !scroller.current || !surface.current) return;
    setFailed(null);
    setBars([]);
    const rt = useRuntime.getState();
    const g = new TabGlue(surface.current, scroller.current, {
      tracks: (names, scoreTempo) => {
        rt.patch({ tabTracks: names });
        setTempo(scoreTempo);
      },
      bars: setBars,
      notes: (now, next) => {
        const { semitones, capo } = shift.current;
        const move = (p: { string: number; fret: number }) => shiftFret(p.string, p.fret, semitones, capo);
        useRuntime.getState().patch({ tabNotes: { now: now.map(move), next: next.map(move) } });
      },
      seek: (seconds) => songActions.seekTo(seconds),
      failed: setFailed,
    });
    glue.current = g;
    if (import.meta.env.DEV) (window as unknown as { __kvTab?: TabGlue }).__kvTab = g; // for checks
    let cancelled = false;
    api
      .tab(song.id, tab.addedAt)
      .then((data) => {
        if (!cancelled) g.load(data, tab.ext, tab.track);
      })
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : L().songUi.tab.failed));
    return () => {
      cancelled = true;
      g.destroy();
      glue.current = null;
      useRuntime.getState().patch({ tabTracks: [], tabSync: null, tabNotes: null });
    };
    // the file is what matters: its addedAt changes with every new upload
  }, [song.id, tab?.addedAt]);

  useEffect(() => {
    if (tab) glue.current?.show(tab.track, tab.notation);
  }, [tab?.track, tab?.notation]);

  // Tie the tab to the recording whenever the bars, the analysis or the user's correction change.
  // A tab-song plays the tab itself: its own timeline, no sync points.
  const songBarsNow = songBars(song, analysis);
  const ownTimeline = isTabSong(song);
  useEffect(() => {
    if (!tab || !bars.length) return;
    if (ownTimeline) {
      useRuntime.getState().patch({ tabSync: null });
      glue.current?.sync([]);
      return;
    }
    const auto = autoSync(bars, songBarsNow, effectiveChords(song, analysis), tempo, analysis?.tempo ?? 0);
    const sync = { offset: tab.offset ?? auto.offset, ratio: tab.ratio ?? auto.ratio };
    useRuntime.getState().patch({ tabSync: sync });
    glue.current?.sync(syncTimes(bars, songBarsNow, sync));
    // song.chords: the user's chord edits change the matching too
  }, [bars, songBarsNow, song.chords, tempo, analysis, tab?.offset, tab?.ratio, ownTimeline]);

  useEffect(() => glue.current?.setPlaying(playing), [playing]);

  useEngineFrame((_, now) => {
    if (useSong.getState().state === 'ready') glue.current?.position(songPlayer.position(now));
  });

  if (!tab) {
    return (
      <div className="empty">
        <FileMusic size={36} />
        <h2 className="empty__title">{t.songUi.tab.emptyTitle}</h2>
        <p className="empty__text">{t.songUi.tab.empty}</p>
        <div className="empty__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={() => picker.current?.click()}>
            {t.songUi.tab.choose}
          </button>
        </div>
        <input
          ref={picker}
          type="file"
          hidden
          accept=".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.mxl,.xml"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void textActions.addTabFile(file);
          }}
        />
      </div>
    );
  }
  return (
    <div className="tabview">
      <div className="view-tools">
        {failed && <span className="note note--cold">{failed}</span>}
        <span className="tabview__name" title={tab.name}>
          {tab.name}
        </span>
        {parts.length > 1 && (
          <label className="tabview__part" title={withKey(t.songUi.nextPart, "'")}>
            {t.songUi.tab.part}
            <select
              className="sel"
              value={Math.min(tab.track, parts.length - 1)}
              onChange={(e) => {
                textActions.pickTabTrack(Number(e.target.value));
                e.target.blur(); // give the keys back to the shortcuts
              }}
            >
              {parts.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* The keys of this bar (', Shift+', ;, Shift+;) are on the Keys sheet. */}
        <button type="button" className="iconbtn iconbtn--sm" aria-label={t.songUi.print} title={t.songUi.print} onClick={() => glue.current?.print()}>
          <Printer size={14} />
        </button>
        {!ownTimeline && (
          <button type="button" className="iconbtn iconbtn--sm" aria-label={t.songUi.tab.remove} title={t.songUi.tab.remove} onClick={() => void textActions.removeTab()}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div ref={scroller} className="tabview__scroll">
        <div ref={surface} className="tabview__surface" />
      </div>
    </div>
  );
}
