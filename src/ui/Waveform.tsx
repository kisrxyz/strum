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
/** Height of the band with the song's sections at the top of the timeline, CSS px. */
const SECTION_BAND = 20;

const SECTION_KINDS: readonly SectionKind[] = ['intro', 'verse', 'chorus', 'bridge', 'solo', 'outro', 'other'];

/** `#rrggbb` with an alpha, for the canvas. */
function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The colours of the timeline, from the tokens (tokens.css): each kind of section has its own. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const value = css.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  const section = Object.fromEntries(SECTION_KINDS.map((kind) => [kind, v(`--sec-${kind}`, '#8b919c')])) as Record<SectionKind, string>;
  return {
    accent: v('--accent', '#ffad33'),
    text: v('--text', '#e9eaec'),
    section,
    rest: 'rgba(233, 234, 236, 0.3)',
  };
}

/** The wave drawn twice, ready to be glued at the playhead: played (amber) and still to come. */
interface Layers {
  played: HTMLCanvasElement;
  rest: HTMLCanvasElement;
}

/**
 * The whole song as a timeline: its sections as blocks of colour on top, the waveform with its
 * bars under them. Click to jump, drag to make a loop (sticks to bar lines when the song has bars).
 *
 * Everything but the playhead is drawn into two pictures when something changes (size, song,
 * bars, loop, bookmarks). A frame only glues them at the playhead: drawing the ~1500 columns and
 * reading the canvas size every frame took time from what moves under it.
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

    // Sections: a block of its kind's colour in the band, a faint wash of it under the block.
    const analysis = useSong.getState().analysis;
    const sections = analysis?.sections ?? [];
    const band = sections.length ? SECTION_BAND : 0;
    g.font = `600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`;
    g.textBaseline = 'middle';
    const fromFile = isTabSong(s);
    sections.forEach((part, i) => {
      const x0 = Math.round(x(part.start));
      const width = Math.round(x(part.end)) - x0;
      const hue = col.section[part.kind];
      g.fillStyle = alpha(hue, 0.045);
      g.fillRect(x0, band, width, h - band);
      g.fillStyle = alpha(hue, 0.2);
      g.fillRect(x0 + 1, 0, Math.max(1, width - 1), band);
      g.fillStyle = alpha(hue, 0.9);
      g.fillRect(x0 + 1, 0, Math.max(1, width - 1), 2);
      // A name only when it fits whole: a cut word reads as a mistake.
      const label = sectionLabel(sections, i, fromFile);
      if (label && g.measureText(label).width + 12 <= width) {
        g.fillStyle = alpha(col.text, 0.86);
        g.fillText(label, x0 + 7, band / 2 + 2);
      }
    });
    const barList = bars();
    if (barList.length && w / barList.length >= 3) {
      for (const bar of barList) {
        g.fillStyle = bar.number % 4 === 1 ? 'rgba(255, 255, 255, 0.09)' : 'rgba(255, 255, 255, 0.035)';
        g.fillRect(Math.round(x(bar.start)), band, 1, h - band);
      }
    }

    const loop = preview.current ?? s.player.loop;
    const hasLoop = loop.end - loop.start >= MIN_LOOP;
    if (hasLoop) {
      g.fillStyle = loop.on ? alpha(col.accent, 0.16) : 'rgba(255, 255, 255, 0.06)';
      g.fillRect(x(loop.start), band, x(loop.end) - x(loop.start), h - band);
    }

    const count = Math.max(1, Math.floor(w));
    if (peaks.current && (!columns.current || columns.current.length !== count * 2)) {
      columns.current = peakColumns(peaks.current, PEAKS_PER_SECOND, count, duration);
    }
    const cols = columns.current;
    if (cols) {
      const mid = band + (h - band) / 2;
      const scale = ((h - band) / 2) * 0.86;
      g.fillStyle = waveColor;
      for (let i = 0; i < count; i++) {
        const top = mid - cols[2 * i + 1] * scale;
        const bottom = mid - cols[2 * i] * scale;
        g.fillRect(i, top, 1, Math.max(1, bottom - top));
      }
    } else {
      g.fillStyle = 'rgba(255, 255, 255, 0.1)';
      g.fillRect(0, band + (h - band) / 2, w, 1);
    }

    // The loop's ends: a line with a small flag in the band (dimmer while the loop is off).
    g.fillStyle = hasLoop && !loop.on ? alpha(col.accent, 0.55) : col.accent;
    const edge = (at: number, dir: 1 | -1) => {
      const ex = Math.round(x(at));
      g.fillRect(ex - 1, 0, 2, h);
      g.beginPath();
      g.moveTo(ex, 0);
      g.lineTo(ex + dir * 7, 0);
      g.lineTo(ex, 9);
      g.fill();
    };
    if (hasLoop) {
      edge(loop.start, 1);
      edge(loop.end, -1);
    } else if (loop.start > 0) {
      edge(loop.start, 1); // A is set, B not yet
    }
    // Bookmarks: a dot at the foot of the wave.
    g.fillStyle = alpha(col.text, 0.8);
    for (const mark of s.player.bookmarks) {
      g.beginPath();
      g.arc(Math.round(x(mark.start)), h - 4, 2.5, 0, Math.PI * 2);
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
      [next.played, alpha(col.accent, 0.9)],
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
      g.fillStyle = colors.current?.text ?? '#e9eaec';
      g.fillRect(Math.round((playhead - 1) * dpr), 0, Math.max(2, Math.round(2 * dpr)), c.height);
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
      className="timeline"
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
