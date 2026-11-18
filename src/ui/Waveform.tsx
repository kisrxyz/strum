import { useEffect, useRef } from 'react';
import { useLang } from '../i18n/useLang';
import { snapToBar } from '../music/bars';
import { songActions } from '../song/actions';
import { api } from '../song/api';
import { songBars } from '../song/grid';
import { sectionLabel } from '../song/sections';
import { peakColumns } from '../song/peaks';
import { songPlayer } from '../song/player';
import { MIN_LOOP } from '../song/schedule';
import { isTabSong, type Loop, type SectionKind, type Song } from '../song/types';
import { useSong } from '../state/song';
import { useEngineFrame } from './useEngineFrame';

const PEAKS_PER_SECOND = 100;
const DRAG_PX = 5;
/** Height of the band with the song's sections at the top of the wave, CSS px. */
const SECTION_BAND = 18;

/** Section tints over the whole wave: the chorus warm, the solo cold, the rest barely there. */
const SECTION_TINT: Record<SectionKind, string> = {
  intro: 'rgba(239, 233, 222, 0.02)',
  verse: 'rgba(239, 233, 222, 0.035)',
  chorus: 'rgba(242, 162, 74, 0.08)',
  bridge: 'rgba(239, 233, 222, 0.02)',
  solo: 'rgba(116, 171, 203, 0.08)',
  outro: 'rgba(239, 233, 222, 0.02)',
  other: 'rgba(239, 233, 222, 0.02)',
};

function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#f2a24a'),
    text3: v('--text-3', '#857f75'),
    line: v('--line-2', 'rgba(239, 233, 222, 0.14)'),
    played: 'rgba(242, 162, 74, 0.62)',
    rest: 'rgba(239, 233, 222, 0.26)',
  };
}

/** The wave drawn twice, ready to be glued at the playhead: played (warm) and still to come. */
interface Layers {
  played: HTMLCanvasElement;
  rest: HTMLCanvasElement;
}

/**
 * The whole song as a waveform with its bars and sections: click to jump, drag to make a loop
 * (sticks to bar lines when the song has bars).
 *
 * Everything but the playhead is drawn into two pictures when something changes (size, song,
 * bars, loop, bookmarks). A frame only glues them at the playhead: drawing the ~1500 columns and
 * reading the canvas size every frame took time from the moving chord lane.
 */
export function Waveform({ song }: { song: Song }) {
  const t = useLang();
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const layers = useRef<Layers | null>(null);
  /** Playhead (CSS px) of the last glued frame; NaN = glue again on the next one. */
  const shown = useRef(Number.NaN);
  const peaks = useRef<Int8Array | null>(null);
  const columns = useRef<Float32Array | null>(null);
  const colors = useRef<ReturnType<typeof palette> | null>(null);
  const drag = useRef<{ x0: number; t0: number; moved: boolean } | null>(null);
  const preview = useRef<Loop | null>(null);
  const songRef = useRef(song);
  songRef.current = song;

  const timeAt = (clientX: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * songRef.current.duration;
  };
  const bars = () => songBars(songRef.current, useSong.getState().analysis);
  const snapped = (t: number) => {
    const list = bars();
    return list.length ? snapToBar(list, t) : t;
  };

  /** Draws everything but the playhead, with the wave in `waveColor`. */
  const paint = (g: CanvasRenderingContext2D, w: number, h: number, dpr: number, waveColor: string) => {
    const col = (colors.current ??= palette());
    const s = songRef.current;
    const duration = s.duration || 1;
    const x = (t: number) => (t / duration) * w;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // Sections: a band of colour on top with their names; bar lines across the wave.
    const analysis = useSong.getState().analysis;
    const sections = analysis?.sections ?? [];
    const band = sections.length ? SECTION_BAND : 0;
    g.font = `500 12px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`;
    g.textBaseline = 'middle';
    const fromFile = isTabSong(s);
    sections.forEach((part, i) => {
      const x0 = x(part.start);
      const width = x(part.end) - x0;
      g.fillStyle = SECTION_TINT[part.kind];
      g.fillRect(x0, 0, width, h);
      g.fillStyle = col.line;
      g.fillRect(Math.round(x0), 0, 1, h);
      // A name only when it fits whole: a cut word ("Вступлени", "Конц") reads as a mistake.
      const label = sectionLabel(sections, i, fromFile);
      if (label && g.measureText(label).width + 12 <= width) {
        g.fillStyle = part.kind === 'chorus' ? 'rgba(242, 162, 74, 0.85)' : col.text3;
        g.fillText(label, x0 + 6, band / 2 + 3);
      }
    });
    const barList = bars();
    if (barList.length && w / barList.length >= 3) {
      for (const bar of barList) {
        g.fillStyle = bar.number % 4 === 1 ? 'rgba(239, 233, 222, 0.1)' : 'rgba(239, 233, 222, 0.04)';
        g.fillRect(Math.round(x(bar.start)), band, 1, h - band);
      }
    }

    const loop = preview.current ?? s.player.loop;
    const hasLoop = loop.end - loop.start >= MIN_LOOP;
    if (hasLoop) {
      g.fillStyle = loop.on ? 'rgba(242, 162, 74, 0.14)' : 'rgba(239, 233, 222, 0.06)';
      g.fillRect(x(loop.start), 0, x(loop.end) - x(loop.start), h);
    }

    const count = Math.max(1, Math.floor(w));
    if (peaks.current && (!columns.current || columns.current.length !== count * 2)) {
      columns.current = peakColumns(peaks.current, PEAKS_PER_SECOND, count, duration);
    }
    const cols = columns.current;
    if (cols) {
      const mid = band + (h - band) / 2;
      const scale = ((h - band) / 2) * 0.92;
      g.fillStyle = waveColor;
      for (let i = 0; i < count; i++) {
        const top = mid - cols[2 * i + 1] * scale;
        const bottom = mid - cols[2 * i] * scale;
        g.fillRect(i, top, 1, Math.max(1, bottom - top));
      }
    } else {
      g.fillStyle = col.line;
      g.fillRect(0, h / 2, w, 1);
    }

    g.fillStyle = col.accent;
    if (hasLoop) {
      g.fillRect(x(loop.start) - 1, 0, 2, h);
      g.fillRect(x(loop.end) - 1, 0, 2, h);
    } else if (loop.start > 0) {
      g.fillRect(x(loop.start) - 1, 0, 2, h); // A is set, B not yet
    }
    for (const mark of s.player.bookmarks) {
      const bx = x(mark.start);
      g.beginPath();
      g.moveTo(bx - 7, 0);
      g.lineTo(bx + 7, 0);
      g.lineTo(bx, 10);
      g.fill();
    }
  };

  /** Redraws the two pictures (and sizes the canvas to the screen's pixels). */
  const rebuild = () => {
    const c = canvas.current;
    const { w, h } = size.current;
    if (!c || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const col = (colors.current ??= palette());
    const next = layers.current ?? { played: document.createElement('canvas'), rest: document.createElement('canvas') };
    for (const [layer, color] of [
      [next.played, col.played],
      [next.rest, col.rest],
    ] as const) {
      if (layer.width !== pw || layer.height !== ph) {
        layer.width = pw;
        layer.height = ph;
      }
      const g = layer.getContext('2d');
      if (g) paint(g, w, h, dpr, color);
    }
    layers.current = next;
    shown.current = Number.NaN;
  };

  /** Glues the pictures at the playhead and draws it; skipped while nothing moved. */
  const draw = (now?: number) => {
    const c = canvas.current;
    const pics = layers.current;
    const { w } = size.current;
    if (!c || !pics || !w) return;
    if (c.width !== Math.round(w * (window.devicePixelRatio || 1))) {
      rebuild(); // the screen's pixel ratio changed (browser zoom, another monitor)
    }
    const s = songRef.current;
    const loaded = useSong.getState().state === 'ready';
    const playhead = loaded ? (songPlayer.position(now) / (s.duration || 1)) * w : -1;
    if (playhead === shown.current) return;
    shown.current = playhead;
    const g = c.getContext('2d');
    if (!g) return;
    const dpr = c.width / w;
    const split = Math.min(c.width, Math.max(0, Math.round(playhead * dpr)));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (split > 0) g.drawImage(pics.played, 0, 0, split, c.height, 0, 0, split, c.height);
    if (split < c.width) g.drawImage(pics.rest, split, 0, c.width - split, c.height, split, 0, c.width - split, c.height);
    if (playhead >= 0) {
      g.fillStyle = colors.current?.accent ?? '#f2a24a';
      g.fillRect((playhead - 1) * dpr, 0, 2 * dpr, c.height);
    }
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      size.current = { w: width, h: height };
      rebuild();
      draw();
    });
    observer.observe(c);
    return () => observer.disconnect();
    // rebuild() and draw() read only refs
  }, []);

  // A tab-song's waveform comes with its render (another part on screen: drawn again).
  const tabPeaks = useSong((s) => (isTabSong(s.song) ? s.peaks : null));
  const tabSong = isTabSong(song);

  useEffect(() => {
    let cancelled = false;
    peaks.current = null;
    columns.current = null;
    if (tabSong) {
      peaks.current = tabPeaks;
      rebuild();
      draw();
      return;
    }
    api
      .peaks(song.id)
      .then((p) => {
        if (cancelled) return;
        peaks.current = p;
        columns.current = null;
        rebuild();
        draw();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // rebuild() reads only refs, so the song id (or a tab-song's render) is what matters
  }, [song.id, tabSong, tabPeaks]);

  // Any render (the song's loop, bookmarks, bar shift; a new analysis) redraws the pictures.
  useEffect(() => {
    rebuild();
    draw();
  });

  useEngineFrame((_, now) => draw(now));

  return (
    <canvas
      ref={canvas}
      className="wave"
      aria-label={t.songUi.wave}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x0: e.clientX, t0: timeAt(e.clientX), moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x0) > DRAG_PX) d.moved = true;
        if (!d.moved) return;
        const t = timeAt(e.clientX);
        preview.current = { start: snapped(Math.min(d.t0, t)), end: snapped(Math.max(d.t0, t)), on: true };
        rebuild();
        draw();
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        const range = preview.current;
        preview.current = null;
        if (d?.moved && range) songActions.setLoop(range.start, range.end);
        else if (d) songActions.seekTo(timeAt(e.clientX));
        rebuild();
        draw();
      }}
    />
  );
}
