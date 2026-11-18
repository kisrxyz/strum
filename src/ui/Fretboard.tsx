import { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n/useLang';
import { chordTones, noteName, type Chord } from '../music/chords';
import { openStrings, shapePitchClass, shapeSpelling, soundingChord } from '../music/display';
import { FRETS, noteRole, placeNote, placesOf, positionsOf, type FretPos, type NoteRole } from '../music/fretboard';
import { degreeName, scalePitchClasses, type Key } from '../music/keys';
import { matchesNote } from '../music/match';
import { visibility } from '../music/track';
import { NoteTrail } from '../music/trail';
import { TUNINGS } from '../music/tunings';
import { voicings } from '../music/voicings';
import { viewOptions } from '../song/chordView';
import type { Analysis, Song } from '../song/types';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { useEngineFrame } from './useEngineFrame';

const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];
const NUMBERED = [3, 5, 7, 9, 12, 15, 17, 19, 21];
/** A played note glows this long (SPEC §5: about two seconds). */
const GLOW_MS = 2000;

interface Played {
  id: number;
  pos: FretPos;
  /** 'match': «совпало» with the recording's or the tab's note (a glow, no score). */
  role: NoteRole | 'match';
}

/** The song's key as it sounds (moved with the song's pitch shift). */
export function soundingKey(analysis: Analysis | null, song: Song): Key | null {
  const key = analysis?.key;
  if (!key) return null;
  return { tonic: (((key.tonic + song.player.semitones) % 12) + 12) % 12, mode: key.mode };
}

/** The tab's notes at the cursor (where to put the fingers) and the next ones (faint). */
export interface TabNotes {
  now: FretPos[];
  next: FretPos[];
}

/** «Ноты»: the recording's note now and the next one (sounding MIDI, the song's pitch shift applied). */
export interface NoteMarks {
  now: number | null;
  next: number | null;
}

/**
 * The neck, thin string on top: the current chord's notes (F: chord → scale → nothing, D: degrees),
 * the chosen fingering as rings, the capo, and the notes you play glowing warm / neutral / cold.
 * With a tab running (`tabNotes`), the tab's notes take the place of the chord's; in «Ноты»
 * (`noteMarks`) the recording's note now shows at every place it can be played. `expected` gives
 * the notes a played note is matched with («совпало»).
 */
export function Fretboard({
  song,
  analysis,
  label,
  tabNotes = null,
  noteMarks = null,
  expected = null,
}: {
  song: Song;
  analysis: Analysis | null;
  label: string;
  tabNotes?: TabNotes | null;
  noteMarks?: NoteMarks | null;
  expected?: ((now: number) => number[]) | null;
}) {
  const t = useLang();
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [played, setPlayed] = useState<Played[]>([]);
  const trail = useRef(new NoteTrail());
  const lastPos = useRef<FretPos | null>(null);
  const nextId = useRef(1);
  const neckView = useSettings((s) => s.neckView);
  const degrees = useSettings((s) => s.degrees);
  const voicingIndex = useSong((s) => s.voicing);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const o = viewOptions(song);
  const strings = TUNINGS[o.tuning].strings;
  const capo = o.capo;
  const chord: Chord | null = soundingChord(label, o);
  const key = soundingKey(analysis, song);
  const visible = visibility(song.player.mode, song.player.reveal);
  // Note names as you play them (from the capo, in the guitar's tuning), like the chord names.
  const spelling = shapeSpelling(analysis?.key ?? null, o);

  // Played notes: a new stable note from the tuner's pitch lights up where it is most likely played.
  useEngineFrame((s, now) => {
    const midi = s.note ? s.note.midi : null;
    const fresh = trail.current.push(midi, performance.now());
    if (fresh === null) return;
    const pos = placeNote(fresh, strings, capo, lastPos.current);
    if (!pos) return;
    lastPos.current = pos;
    const role = expected && matchesNote(fresh, expected(now)) ? 'match' : noteRole(((fresh % 12) + 12) % 12, chord, key);
    const id = nextId.current++;
    setPlayed((list) => [...list.slice(-11), { id, pos, role }]);
    setTimeout(() => setPlayed((list) => list.filter((p) => p.id !== id)), GLOW_MS);
  });
  const { w, h } = size;
  if (!w || !h) return <div ref={wrap} className="fret" aria-label={t.songUi.fretboard} />;

  const padTop = 6;
  const padBottom = 24;
  const openW = Math.max(28, w * 0.035);
  const fw = (w - openW - 4) / FRETS;
  const sh = (h - padTop - padBottom) / 6;
  const r = Math.max(7, Math.min(fw, sh) * 0.42);
  const x = (fret: number) => (fret <= capo ? (capo ? openW + (capo - 0.5) * fw : openW / 2) : openW + (fret - 0.5) * fw);
  const y = (string: number) => padTop + (5.5 - string) * sh;
  const midY = padTop + 3 * sh;

  const tones = chord ? chordTones(chord) : [];
  // The tab or the recording's notes lead the hand: no chord, no scale under them.
  const lead = tabNotes !== null || noteMarks !== null;
  // «Аппликатура» (the default): only the chosen fingering with its fingers; else all the chord's notes.
  const shape = !lead && neckView === 'shape';
  const showChord = !lead && !shape && chord !== null && visible.currentName;
  const showScale = !lead && !shape && key !== null && visible.currentName && neckView === 'scale';
  const scale = showScale && key ? scalePitchClasses(key).filter((pc) => !tones.includes(pc)) : [];
  const label12 = (pc: number) => (degrees && chord ? degreeName(pc, chord.root) : noteName(shapePitchClass(pc, o), spelling));

  const list = !lead && chord && visible.fingerings ? voicings(chord, openStrings(o)) : [];
  const markNow = noteMarks?.now != null ? placesOf(noteMarks.now, strings, capo) : [];
  const markNext =
    noteMarks?.next != null && noteMarks.next !== noteMarks.now ? placesOf(noteMarks.next, strings, capo) : [];
  const tabLabel = (p: FretPos) => noteName(shapePitchClass(strings[p.string] + p.fret, o), spelling);
  const voicing = list.length ? list[voicingIndex % list.length] : null;

  return (
    <div ref={wrap} className="fret" aria-label={t.songUi.fretboard}>
      <svg width={w} height={h} role="img">
        {/* fret wires, nut, capo */}
        {Array.from({ length: FRETS + 1 }, (_, f) => (
          <line
            key={`w${f}`}
            className={f === 0 ? 'fret__nut' : 'fret__wire'}
            x1={openW + f * fw}
            x2={openW + f * fw}
            y1={y(5)}
            y2={y(0)}
          />
        ))}
        {INLAYS.map((f) => (
          <circle key={`i${f}`} className="fret__inlay" cx={openW + (f - 0.5) * fw} cy={midY} r={r * 0.35} />
        ))}
        <circle className="fret__inlay" cx={openW + 11.5 * fw} cy={midY - sh} r={r * 0.35} />
        <circle className="fret__inlay" cx={openW + 11.5 * fw} cy={midY + sh} r={r * 0.35} />
        {strings.map((_, s) => (
          <line key={`s${s}`} className="fret__string" x1={openW} x2={w} y1={y(s)} y2={y(s)} style={{ strokeWidth: 1 + (5 - s) * 0.35 }} />
        ))}
        {capo > 0 && <rect className="fret__capo" x={openW + (capo - 0.5) * fw - 5} y={y(5) - sh * 0.4} width={10} height={y(0) - y(5) + sh * 0.8} rx={5} />}
        {NUMBERED.map((f) => (
          <text key={`n${f}`} className="fret__num" x={openW + (f - 0.5) * fw} y={h - 5}>
            {f}
          </text>
        ))}

        {/* the scale, then the chord's notes */}
        {scale.flatMap((pc) =>
          positionsOf(pc, strings, capo).map((p) => (
            <circle key={`sc${pc}-${p.string}-${p.fret}`} className="fret__scale" cx={x(p.fret)} cy={y(p.string)} r={r * 0.45} />
          )),
        )}
        {showChord &&
          tones.flatMap((pc) =>
            positionsOf(pc, strings, capo).map((p) => (
              <g key={`t${pc}-${p.string}-${p.fret}`} className={pc === chord?.root ? 'fret__tone fret__tone--root' : 'fret__tone'}>
                <circle cx={x(p.fret)} cy={y(p.string)} r={r} />
                <text x={x(p.fret)} y={y(p.string)} style={{ fontSize: `${Math.round(r * 1.05)}px` }}>
                  {label12(pc)}
                </text>
              </g>
            )),
          )}

        {/* the chosen fingering: rings around the chord's notes, or on its own as the shape to hold */}
        {!shape &&
          voicing?.frets.map((rel, s) =>
            rel < 0 ? null : <circle key={`v${s}`} className="fret__voicing" cx={x(rel + capo)} cy={y(s)} r={r + 3} />,
          )}
        {shape && voicing?.barre && (
          <rect
            className="fret__barre"
            x={x(voicing.barre.fret + capo) - r}
            y={y(voicing.barre.to) - r}
            width={2 * r}
            height={y(voicing.barre.from) - y(voicing.barre.to) + 2 * r}
            rx={r}
          />
        )}
        {shape &&
          voicing?.frets.map((rel, s) =>
            rel < 0 ? (
              <text key={`v${s}`} className="fret__mute" x={capo ? x(capo) : openW / 2} y={y(s)}>
                ×
              </text>
            ) : rel === 0 ? (
              <circle key={`v${s}`} className="fret__open" cx={x(capo)} cy={y(s)} r={r * 0.55} />
            ) : (
              <g key={`v${s}`} className="fret__finger">
                <circle cx={x(rel + capo)} cy={y(s)} r={r} />
                <text x={x(rel + capo)} y={y(s)} style={{ fontSize: `${Math.round(r * 1.05)}px` }}>
                  {voicing.fingers[s] || ''}
                </text>
              </g>
            ),
          )}

        {/* the tab: the next notes faint, the ones to play now warm */}
        {tabNotes?.next.map((p) => (
          <circle key={`tn${p.string}-${p.fret}`} className="fret__tab fret__tab--next" cx={x(p.fret)} cy={y(p.string)} r={r * 0.8} />
        ))}
        {tabNotes?.now.map((p) => (
          <g key={`tc${p.string}-${p.fret}`} className="fret__tab">
            <circle cx={x(p.fret)} cy={y(p.string)} r={r} />
            <text x={x(p.fret)} y={y(p.string)} style={{ fontSize: `${Math.round(r * 1.05)}px` }}>
              {tabLabel(p)}
            </text>
          </g>
        ))}

        {/* «Ноты»: the next note faint, the one sounding now at every place it can be played */}
        {markNext.map((p) => (
          <circle key={`mn${p.string}-${p.fret}`} className="fret__tab fret__tab--next" cx={x(p.fret)} cy={y(p.string)} r={r * 0.8} />
        ))}
        {markNow.map((p) => (
          <g key={`mc${p.string}-${p.fret}`} className="fret__tab">
            <circle cx={x(p.fret)} cy={y(p.string)} r={r} />
            <text x={x(p.fret)} y={y(p.string)} style={{ fontSize: `${Math.round(r * 1.05)}px` }}>
              {tabLabel(p)}
            </text>
          </g>
        ))}

        {/* what you play */}
        {played.map((p) => (
          <circle key={`p${p.id}`} className={`fret__played fret__played--${p.role}`} cx={x(p.pos.fret)} cy={y(p.pos.string)} r={r * 0.9} />
        ))}
      </svg>
    </div>
  );
}
