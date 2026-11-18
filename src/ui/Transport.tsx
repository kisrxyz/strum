import { Guitar, Metronome, Minus, Music, Pause, Play, Plus, Repeat, SkipBack, SlidersVertical } from 'lucide-react';
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { barAt } from '../music/bars';
import { songActions } from '../song/actions';
import { fmtPitch, fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { songBars } from '../song/grid';
import { songPlayer } from '../song/player';
import { MIN_LOOP } from '../song/schedule';
import { isTabSong, type Analysis, type Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import {
  GUITAR_VOLUME_MAX_DB,
  GUITAR_VOLUME_MIN_DB,
  SONG_VOLUME_MAX_DB,
  SONG_VOLUME_MIN_DB,
  useSettings,
} from '../state/settings';
import { useSong } from '../state/song';
import { fmtDb } from './controls';
import { IconNeck } from './icons';
import { separationText } from './Mixer';
import { useEngineFrame } from './useEngineFrame';

/** The time and the bar in a sunk field, written every frame without re-rendering React. */
function Clock({ song }: { song: Song }) {
  const t = useLang();
  const time = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  useEngineFrame((_, now) => {
    const s = useSong.getState();
    const pos = s.state === 'ready' ? songPlayer.position(now) : 0;
    const bars = songBars(s.song, s.analysis);
    const index = bars.length ? barAt(bars, pos) : -1;
    const at = fmtTime(pos);
    const b = index >= 0 && bars[index].number > 0 ? t.songUi.transport.bar(bars[index].number) : '';
    if (at + b === last.current) return;
    last.current = at + b;
    if (time.current) time.current.textContent = at;
    if (bar.current) bar.current.textContent = b;
  });
  return (
    <div className="readout transport__clock">
      <span ref={time} className="transport__time">
        0:00
      </span>
      <span className="transport__total">/ {fmtTime(song.duration)}</span>
      <span ref={bar} className="transport__bar" />
    </div>
  );
}

/** Repeat after me: whose pass of the loop it is, updated every frame without re-rendering React. */
function RepeatChip() {
  const t = useLang();
  const text = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  useEngineFrame((_, now) => {
    const words = songPlayer.loopPass(now) % 2 === 0 ? t.songUi.transport.repeatListen : t.songUi.transport.repeatPlay;
    if (words === last.current || !text.current) return;
    last.current = words;
    text.current.textContent = words;
  });
  return (
    <button type="button" className="tag tag--on" title={withKey(t.songUi.repeat, 'Shift+R')} onClick={() => funActions.toggleRepeat()}>
      <span ref={text}>{t.songUi.repeat}</span>
    </button>
  );
}

/** A value with − and + around it; a click on the value puts it back. */
function Step(props: { label: string; value: string; on: boolean; down: string; up: string; reset: string; onStep: (dir: 1 | -1) => void; onReset: () => void }) {
  return (
    <div className="tfield">
      <span className="tfield__label">{props.label}</span>
      <span className={`stepper${props.on ? ' is-on' : ''}`}>
        <button type="button" aria-label={props.down} title={props.down} onClick={() => props.onStep(-1)}>
          <Minus size={14} />
        </button>
        <button type="button" className="stepper__value" title={props.reset} onClick={props.onReset}>
          {props.value}
        </button>
        <button type="button" aria-label={props.up} title={props.up} onClick={() => props.onStep(1)}>
          <Plus size={14} />
        </button>
      </span>
    </div>
  );
}

function Volume(props: { icon: ReactNode; name: string; keys: string; db: number; min: number; max: number; onChange: (db: number) => void }) {
  const pct = ((props.db - props.min) / (props.max - props.min)) * 100;
  return (
    <label className="vol" title={withKey(props.name, props.keys)}>
      {props.icon}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={1}
        value={props.db}
        aria-label={props.name}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="vol__db num">{fmtDb(props.db)}</span>
    </label>
  );
}

/** Your guitar and the song: the two volumes one turns while playing. */
function Volumes() {
  const m = useLang().songUi.mixer;
  const guitarDb = useSettings((s) => s.guitarDb);
  const songDb = useSettings((s) => s.songVolumeDb);
  const setGuitarDb = useSettings((s) => s.setGuitarDb);
  const setSongDb = useSettings((s) => s.setSongVolumeDb);
  return (
    <div className="vols">
      <Volume icon={<Guitar size={16} />} name={m.guitarVolume} keys="Alt+↑ ↓" db={guitarDb} min={GUITAR_VOLUME_MIN_DB} max={GUITAR_VOLUME_MAX_DB} onChange={setGuitarDb} />
      <Volume icon={<Music size={16} />} name={m.songVolume} keys="Shift+↑ ↓" db={songDb} min={SONG_VOLUME_MIN_DB} max={SONG_VOLUME_MAX_DB} onChange={setSongDb} />
    </div>
  );
}

/**
 * The player's bottom row: to the start, play, the time and the bar; the loop, the click and the
 * count-in as lit buttons; speed and pitch with their steps; the original guitar; the two volumes;
 * the neck and the mixer. Each button's key is in its tooltip. What is rarely touched lives in
 * the options panel, and shows here only while it is on.
 */
export function Transport({ song, analysis: _analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const u = t.songUi;
  const playing = useSong((s) => s.playing);
  const state = useSong((s) => s.state);
  const mixerOpen = useSong((s) => s.mixerOpen);
  const repeat = useRuntime((s) => s.repeat);
  const trainer = useRuntime((s) => s.speedTrainer);
  const neckShown = useSettings((s) => s.neckShown[song.player.view]);
  const p = song.player;
  const loopSet = p.loop.end - p.loop.start >= MIN_LOOP;
  const loopOn = loopSet && p.loop.on;
  const stems = separationText(song);
  const guitarOn = !p.muted.includes('guitar');
  const tabSong = isTabSong(song);
  const loopText = loopSet ? `${fmtTime(p.loop.start)}–${fmtTime(p.loop.end)}` : p.loop.start > 0 ? u.transport.loopFrom(fmtTime(p.loop.start)) : '';

  return (
    <footer className="transport" aria-label={u.transport.label}>
      <div className="transport__group">
        <button type="button" className="iconbtn iconbtn--lg" aria-label={u.transport.toStart} title={withKey(u.transport.toStart, 'Home')} onClick={() => songActions.home()}>
          <SkipBack />
        </button>
        <button
          type="button"
          className={`transport__play${playing ? ' is-on' : ''}`}
          disabled={state !== 'ready'}
          title={withKey(playing ? u.transport.pause : u.transport.play, u.spaceKey)}
          aria-label={playing ? u.transport.pause : u.transport.play}
          onClick={() => songActions.togglePlay()}
        >
          {playing ? <Pause size={20} fill="currentColor" strokeWidth={0} /> : <Play size={20} fill="currentColor" strokeWidth={0} />}
        </button>
        <Clock song={song} />
      </div>

      <span className="transport__sep" aria-hidden="true" />

      <div className="transport__group">
        <button
          type="button"
          className="btn transport__loop"
          aria-pressed={loopOn}
          title={`${withKey(u.transport.loopOnOff, 'R')} · ${withKey(u.transport.loopEnds, 'A B')} · ${withKey(u.loopSection, 'Q')}`}
          onClick={() => songActions.toggleLoop()}
        >
          <Repeat size={16} />
          {loopText ? <span className="num">{loopText}</span> : u.loop}
        </button>
        <button type="button" className="iconbtn iconbtn--lg" aria-pressed={p.click} aria-label={u.click} title={withKey(u.click, 'C')} onClick={() => songActions.toggleClick()}>
          <Metronome />
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--lg transport__count num"
          aria-pressed={p.countIn}
          aria-label={u.countIn}
          title={withKey(u.countIn, 'O')}
          onClick={() => songActions.toggleCountIn()}
        >
          1234
        </button>
      </div>

      <span className="transport__sep" aria-hidden="true" />

      <div className="transport__group">
        <Step
          label={u.speed}
          value={t.common.units.pct(Math.round(p.speed * 100))}
          on={p.speed !== 1}
          down={withKey(u.transport.slower, '−')}
          up={withKey(u.transport.faster, '=')}
          reset={u.transport.clickToReset}
          onStep={(dir) => songActions.stepSpeed(dir)}
          onReset={() => songActions.setSpeed(1)}
        />
        <Step
          label={u.pitch}
          value={fmtPitch(p.semitones, p.cents)}
          on={p.semitones !== 0 || p.cents !== 0}
          down={`${withKey(u.transport.pitchDown, ',')} · ${withKey(u.transport.centsTip, 'Shift+,')}`}
          up={`${withKey(u.transport.pitchUp, '.')} · ${withKey(u.transport.centsTip, 'Shift+.')}`}
          reset={u.transport.clickToReset}
          onStep={(dir) => songActions.stepPitch(dir, false)}
          onReset={() => songActions.resetPitch()}
        />
      </div>

      <div className="transport__modes">
        {loopOn && repeat && <RepeatChip />}
        {trainer && (
          <button type="button" className="tag tag--on" title={withKey(u.transport.trainerTip, 'Shift+=')} onClick={() => funActions.toggleSpeedTrainer()}>
            {u.trainer}
          </button>
        )}
        {p.mode === 'ear' && (
          <button type="button" className="tag tag--on" title={withKey(u.transport.nextHint, 'J')} onClick={() => songActions.nextHint()}>
            {u.transport.byEar(u.hintsShort[p.reveal])}
          </button>
        )}
      </div>

      <span className="transport__gap" />

      <button
        type="button"
        className="btn transport__guitar"
        aria-pressed={p.solo === 'guitar' || (guitarOn && !p.solo)}
        title={withKey(tabSong ? u.mixer.yourPart : u.originalGuitarTip, 'G')}
        onClick={() => songActions.toggleGuitar()}
      >
        {tabSong ? u.mixer.yourPart : u.originalGuitar}
      </button>
      <Volumes />

      <span className="transport__sep" aria-hidden="true" />

      <div className="transport__group">
        <button
          type="button"
          className="iconbtn iconbtn--lg"
          aria-pressed={neckShown && !mixerOpen}
          aria-label={u.fretboard}
          title={`${withKey(u.fretboard, 'F')} · ${withKey(u.transport.neckShows, 'Shift+F')}`}
          onClick={() => songActions.toggleNeck()}
        >
          <IconNeck />
        </button>
        <button
          type="button"
          className={`iconbtn iconbtn--lg${stems?.tone === 'error' ? ' is-cold' : ''}`}
          aria-pressed={mixerOpen}
          aria-label={u.stems}
          title={stems?.text ?? u.transport.stemsTip}
          onClick={() => songActions.toggleMixer()}
        >
          <SlidersVertical />
        </button>
      </div>
    </footer>
  );
}
