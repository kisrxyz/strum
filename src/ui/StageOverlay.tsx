import { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n/useLang';
import { lineAt } from '../lyrics/align';
import { songLyrics } from '../lyrics/songLyrics';
import { effectiveChords, visibility } from '../music/track';
import { shapeName } from '../song/chordView';
import { songPlayer } from '../song/player';
import type { Analysis, Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSong } from '../state/song';
import { LazyTabPanel } from './LazyTabPanel';
import { useCurrentChord } from './useCurrentChord';
import { useEngineFrame } from './useEngineFrame';

/**
 * «Сцена» (`): the whole screen for playing from two metres — the current chord huge, the next
 * one, and under them the line being sung (the «Текст» view) or the tab (the «Табы» view).
 */
export function StageOverlay() {
  const stage = useRuntime((s) => s.stage);
  const song = useSong((s) => s.song);
  const analysis = useSong((s) => s.analysis);

  // Leaving the browser's full screen (Esc there never reaches the page) closes «Сцена» too.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && useRuntime.getState().stage) useRuntime.getState().patch({ stage: false });
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (!stage || !song) return null;
  return <Stage song={song} analysis={analysis} />;
}

function Stage({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const words = useSong((s) => s.words);
  const track = effectiveChords(song, analysis);
  const index = useCurrentChord(track);
  const lyrics = songLyrics(song, analysis, words);
  const [line, setLine] = useState(-1);
  const last = useRef(-1);
  const visible = visibility(song.player.mode, song.player.reveal);
  const name = (i: number) => (i >= 0 && i < track.length && track[i].chord !== 'N' ? shapeName(track[i].chord, song, analysis) : '—');
  const next = track.findIndex((c, i) => i > index && c.chord !== 'N' && c.chord !== track[index]?.chord);

  useEngineFrame((_, now) => {
    const lines = lyrics?.lines;
    if (!lines) return;
    const i = lineAt(lines, useSong.getState().state === 'ready' ? songPlayer.position(now) : 0);
    if (i !== last.current) {
      last.current = i;
      setLine(i);
    }
  });

  const view = song.player.view;
  const timed = lyrics?.lines;
  const current = timed ? timed[Math.max(0, line)]?.line : undefined;
  const coming = timed ? timed[Math.max(0, line) + 1]?.line : undefined;
  return (
    <div className="stage" role="dialog" aria-label={t.songUi.stageView}>
      <div className="stage__chords">
        <span className="stage__now">{visible.currentName ? name(index) : '?'}</span>
        {visible.allNames && next >= 0 && <span className="stage__next">{t.songUi.next(name(next))}</span>}
      </div>
      {view === 'tab' && song.tab ? (
        <div className="stage__tab">
          <LazyTabPanel song={song} analysis={analysis} />
        </div>
      ) : view === 'lyrics' && lyrics ? (
        <div className="stage__lyrics">
          <p className="stage__line">{current !== undefined ? lyrics.doc.lines[current]?.text || '…' : ''}</p>
          <p className="stage__line stage__line--next">{coming !== undefined ? lyrics.doc.lines[coming]?.text : ''}</p>
        </div>
      ) : null}
      <p className="stage__hint">
        {song.title} · {t.songUi.stage.exit}
      </p>
    </div>
  );
}
