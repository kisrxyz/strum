import { Music2 } from 'lucide-react';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { engine } from '../audio/engine';
import { chromaFromSpectrum, judgeChord } from '../music/chroma';
import { soundingChord } from '../music/display';
import { chordAt, effectiveChords, visibility } from '../music/track';
import { chartRows, rowAt, type ChartBar, type ChartRow } from '../song/chart';
import { shapeName, viewOptions } from '../song/chordView';
import { songBars } from '../song/grid';
import { songPlayer } from '../song/player';
import { isTabSong, type Analysis, type Song } from '../song/types';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { useCurrentChord } from './useCurrentChord';
import { useEngineFrame } from './useEngineFrame';

/** Rows shown after the current one (the box clips what does not fit). */
const NEXT_ROWS = 8;

type Kind = 'prev' | 'now' | 'next';

interface RowProps {
  row: ChartRow | null;
  kind: Kind;
  /** The section name shown in the left column. */
  section: string | null;
  name: (index: number) => string;
  /** Which chords are written: names, change marks only, or nothing («Снять на слух»). */
  marks: (index: number) => 'name' | 'dot' | 'none';
  canEdit: boolean;
  editIndex: number | null;
  rowRef?: Ref<HTMLDivElement>;
  /** The chord sounding now (index into the track). */
  current: number;
}

function BarView({ bar, kind, name, marks, canEdit, editIndex, current }: Omit<RowProps, 'row' | 'section' | 'rowRef'> & { bar: ChartBar }) {
  const t = useLang();
  // A crowded bar (three chords or more, or one on its last beat) writes its chords smaller, so they do not run into the next bar.
  const crowded = bar.chords.length >= 4 ? 0.62 : bar.chords.length === 3 ? 0.76 : bar.chords.some((c) => c.beat > 0 && c.beat >= bar.beats - 1) ? 0.84 : 1;
  return (
    <div className="chart__bar" data-start={bar.start} data-end={bar.end} data-beats={bar.beats} style={crowded < 1 ? ({ '--fit': crowded } as CSSProperties) : undefined}>
      {kind !== 'prev' && <span className="chart__num num">{bar.number}</span>}
      <div className="chart__beats" style={{ gridTemplateColumns: `repeat(${bar.beats}, minmax(0, 1fr))` }}>
        {bar.chords.map(({ beat, index }, k) => {
          const mark = marks(index);
          if (mark === 'none') return null;
          // Two labels that read the same («D» and «D7» with simple chords on) are one chord here.
          if (k > 0 && mark === 'name' && name(bar.chords[k - 1].index) === name(index)) return null;
          return (
            <button
              key={index}
              type="button"
              className={`chart__chord${index === editIndex ? ' is-edit' : ''}${index === current ? ' is-now' : ''}`}
              data-index={index}
              style={{ gridColumn: `${beat + 1}` }}
              disabled={!canEdit}
              title={canEdit ? t.songUi.chart.editChord : undefined}
              onClick={() => useSong.getState().patch({ editIndex: index })}
            >
              {mark === 'name' ? name(index) : <span className="chart__dot" aria-label={t.songUi.chart.change} />}
            </button>
          );
        })}
      </div>
      {kind === 'now' && (
        <div className="chart__ticks" aria-hidden="true">
          {Array.from({ length: bar.beats }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function RowView({ row, kind, section, rowRef, ...rest }: RowProps) {
  // The row carries its section's colour: the name's mark and the line on its left edge.
  const hue = row?.kind ? ({ '--sec': `var(--sec-${row.kind})` } as CSSProperties) : undefined;
  return (
    <div ref={rowRef} className={`chart__row chart__row--${kind}`} style={hue}>
      <div className="chart__section">{section && <span>{section}</span>}</div>
      <div className="chart__bars">
        {row?.bars.map((bar) => <BarView key={bar.start} bar={bar} kind={kind} {...rest} />)}
        {row && Array.from({ length: Math.max(0, 4 - row.bars.length) }, (_, i) => <div key={`e${i}`} className="chart__bar chart__bar--empty" />)}
      </div>
    </div>
  );
}

/**
 * «Аккорды» as a songbook chart: rows of four bars, the row being played big, the one before it
 * faint, the next ones under it. The bar playing now is tinted and its beats fill up one by one;
 * the chord sounding now is warm («Проверь меня» lights it by what the guitar plays). Rows step,
 * they do not scroll. A click on a chord opens the chord editor.
 */
export function ChordChart({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const track = effectiveChords(song, analysis);
  const bars = songBars(song, analysis);
  const fromFile = isTabSong(song);
  const rows = useMemo(() => chartRows(bars, track, analysis?.sections ?? [], 4, fromFile), [bars, track, analysis, fromFile, t]);
  const names = useMemo(() => track.map((seg) => shapeName(seg.chord, song, analysis)), [track, song, analysis]);
  const [row, setRow] = useState(0);
  const rowRef = useRef(0);
  const nowRow = useRef<HTMLDivElement>(null);
  /** What was last written into the current row's DOM: «bar:beat:chord». */
  const drawn = useRef('');
  const spectrum = useRef(new Float32Array(4096));
  const editIndex = useSong((s) => s.editIndex);
  const visible = visibility(song.player.mode, song.player.reveal);
  // The sounding chord re-renders the chart (a few rows): it is warm, and in «Снять на слух» it may
  // be the only one named. The bar tint and the beats move every frame without React.
  const current = useCurrentChord(track);

  // A new current row is a new element: its bar tint and beats are written again.
  useLayoutEffect(() => {
    drawn.current = '';
  });

  useEngineFrame((_, now) => {
    const pos = useSong.getState().state === 'ready' ? songPlayer.position(now) : 0;
    const r = rowAt(rows, pos);
    if (r !== rowRef.current) {
      rowRef.current = r;
      setRow(r);
    }
    const el = nowRow.current;
    if (!el) return;
    const chord = chordAt(track, pos);
    const barEls = Array.from(el.querySelectorAll<HTMLElement>('.chart__bar[data-start]'));
    // The beat marks fill up through the bar; the bar playing now is tinted.
    let barIndex = -1;
    let beat = -1;
    barEls.forEach((b, i) => {
      const start = Number(b.dataset.start);
      const end = Number(b.dataset.end);
      if (pos >= start && pos < end) {
        barIndex = i;
        beat = Math.floor(((pos - start) / (end - start)) * Number(b.dataset.beats));
      }
    });
    const key = `${barIndex}:${beat}`;
    if (key !== drawn.current) {
      drawn.current = key;
      barEls.forEach((b, i) => {
        const on = i === barIndex;
        if ((b.dataset.now === '1') !== on) b.dataset.now = on ? '1' : '';
        b.querySelectorAll('.chart__ticks i').forEach((tick, k) => tick.classList.toggle('on', on && k <= beat));
      });
    }
    // «Проверь меня»: does what the guitar plays fit the chord that sounds now?
    const sampleRate = engine.readSpectrum(spectrum.current);
    const expected = soundingChord(chord >= 0 ? track[chord].chord : 'N', viewOptions(song));
    const judge = sampleRate
      ? judgeChord(chromaFromSpectrum(spectrum.current, sampleRate, useSettings.getState().a4), expected)
      : 'silent';
    if (el.dataset.judge !== judge) el.dataset.judge = judge;
  });

  if (!rows.length) {
    const status = song.analysis?.status;
    const busy = status === 'queued' || status === 'running';
    return (
      <section className="empty" aria-label={t.songUi.views.chords}>
        <Music2 size={36} />
        <p className={`empty__text${status === 'error' ? ' note--cold' : ''}`}>
          {status === 'error'
            ? t.songUi.chart.failed(messageText(song.analysis?.error) || t.songUi.unknownError)
            : busy
              ? t.songUi.chart.finding(song.analysis?.progress ? Math.round(song.analysis.progress * 100) : null)
              : t.songUi.chart.afterStems}
        </p>
        {busy && (
          <span className="bar empty__bar">
            <span style={{ width: `${Math.round((song.analysis?.progress ?? 0) * 100)}%` }} />
          </span>
        )}
      </section>
    );
  }

  const at = Math.max(0, Math.min(row, rows.length - 1));
  const sectionOf = (i: number): string | null => {
    for (let k = i; k >= 0; k--) if (rows[k].section) return rows[k].section;
    return null;
  };
  const marks = (index: number): 'name' | 'dot' | 'none' => {
    if (!visible.changes) return 'none';
    if (visible.allNames) return 'name';
    // «Снять на слух», second hint: only the chord sounding now is named, the rest are change marks.
    return visible.currentName && index === current ? 'name' : 'dot';
  };
  const props = { name: (i: number) => names[i] ?? '—', marks, canEdit: visible.allNames && track.length > 0, editIndex, current };
  return (
    <section className="chart" aria-label={t.songUi.views.chords}>
      <RowView row={at > 0 ? rows[at - 1] : null} kind="prev" section={null} {...props} />
      <RowView row={rows[at]} kind="now" section={sectionOf(at)} rowRef={nowRow} {...props} />
      {rows.slice(at + 1, at + 1 + NEXT_ROWS).map((r, i) => (
        <RowView key={at + 1 + i} row={r} kind="next" section={r.section} {...props} />
      ))}
    </section>
  );
}
