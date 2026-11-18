import { useRef } from 'react';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { barAt } from '../music/bars';
import { TUNINGS } from '../music/tunings';
import { songActions } from '../song/actions';
import { fmtPitch, fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { songBars } from '../song/grid';
import { songPlayer } from '../song/player';
import { MIN_LOOP } from '../song/schedule';
import type { Analysis, Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { separationText, Volumes } from './Mixer';
import { useCapoHint } from './useCapoHint';
import { useEngineFrame } from './useEngineFrame';

const PLAY = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 4.5v15l12-7.5z" />
  </svg>
);
const PAUSE = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </svg>
);
const SETTINGS = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </svg>
);

/** «0:42 · bar 12», written every frame without re-rendering React. */
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
    <div className="transport__clock">
      <span ref={time} className="transport__time num">
        0:00
      </span>
      <span className="transport__total num">/ {fmtTime(song.duration)}</span>
      <span ref={bar} className="transport__bar num" />
    </div>
  );
}

/** «Повтори за мной»: whose pass of the loop it is, updated every frame without re-rendering React. */
function RepeatButton() {
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
    <button
      type="button"
      className="btn btn--on transport__repeat"
      title={withKey(t.songUi.repeat, 'Shift+R')}
      onClick={() => funActions.toggleRepeat()}
    >
      <span ref={text}>{t.songUi.repeat}</span>
    </button>
  );
}

/** A readout you can click: «Скорость 100 %». `on` when it is not at its usual value. */
function Value({ label, value, on, title, onClick }: { label: string; value: string; on: boolean; title: string; onClick: () => void }) {
  return (
    <button type="button" className={`tvalue${on ? ' tvalue--on' : ''}`} title={title} onClick={onClick}>
      <span className="tvalue__label">{label}</span>
      <b className="num">{value}</b>
    </button>
  );
}

/**
 * The song's one bottom row: play, where it is, speed, pitch, the loop, small tags for what is
 * switched on, the volumes, and the three panels that open in the neck's place (Гриф, Дорожки,
 * Настройки). Every button has its key in its tooltip; the keys are listed in «Настройки».
 */
export function Transport({ song, analysis }: { song: Song; analysis: Analysis | null }) {
  const t = useLang();
  const u = t.songUi;
  const playing = useSong((s) => s.playing);
  const state = useSong((s) => s.state);
  const mixerOpen = useSong((s) => s.mixerOpen);
  const settingsOpen = useRuntime((s) => s.songSettings);
  const repeat = useRuntime((s) => s.repeat);
  const trainer = useRuntime((s) => s.speedTrainer);
  const neckShown = useSettings((s) => s.neckShown[song.player.view]);
  const capoHint = useCapoHint(song, analysis);
  const p = song.player;
  const loopSet = p.loop.end - p.loop.start >= MIN_LOOP;
  const loopOn = loopSet && p.loop.on;
  const stems = separationText(song);

  const tags: { text: string; title: string; onClick: () => void }[] = [];
  if (p.mode === 'ear')
    tags.push({ text: u.transport.byEar(u.hintsShort[p.reveal]), title: withKey(u.transport.nextHint, 'J'), onClick: () => songActions.nextHint() });
  if (p.muted.includes('guitar') === false && p.solo !== 'guitar')
    tags.push({ text: u.originalGuitar, title: withKey(u.originalGuitar, 'G'), onClick: () => songActions.toggleGuitar() });
  if (p.solo === 'guitar') tags.push({ text: u.guitarOnly, title: withKey(u.guitarOnly, 'S'), onClick: () => songActions.soloGuitar() });
  if (p.capo) tags.push({ text: u.transport.capoOn(p.capo), title: withKey(u.capo, '[ ]'), onClick: () => songActions.stepCapo(1) });
  else if (capoHint)
    tags.push({ text: u.transport.capoEasier(capoHint.capo), title: withKey(u.capo, ']'), onClick: () => songActions.stepCapo(1) });
  if (p.tuning !== 'standard') tags.push({ text: TUNINGS[p.tuning].name, title: withKey(u.tuning, 'U'), onClick: () => songActions.nextTuning() });
  if (p.simpleChords) tags.push({ text: u.simpleChords, title: withKey(u.simpleChords, 'P'), onClick: () => songActions.toggleSimple() });
  if (p.click) tags.push({ text: u.click, title: withKey(u.click, 'C'), onClick: () => songActions.toggleClick() });
  if (p.countIn) tags.push({ text: u.countIn, title: withKey(u.countIn, 'O'), onClick: () => songActions.toggleCountIn() });

  return (
    <footer className="transport" aria-label={u.transport.label}>
      <button
        type="button"
        className="transport__play"
        disabled={state !== 'ready'}
        title={withKey(playing ? u.transport.pause : u.transport.play, u.spaceKey)}
        aria-label={playing ? u.transport.pause : u.transport.play}
        onClick={() => songActions.togglePlay()}
      >
        {playing ? PAUSE : PLAY}
      </button>
      <Clock song={song} />
      <span className="transport__sep" aria-hidden="true" />
      <Value
        label={u.speed}
        value={t.common.units.pct(Math.round(p.speed * 100))}
        on={p.speed !== 1}
        title={`${withKey(u.transport.speedTip, '− =')}. ${u.transport.clickToReset}`}
        onClick={() => songActions.setSpeed(1)}
      />
      <Value
        label={u.pitch}
        value={fmtPitch(p.semitones, p.cents)}
        on={p.semitones !== 0 || p.cents !== 0}
        title={`${withKey(u.transport.pitchTip, ', .')} · ${withKey(u.transport.centsTip, 'Shift+, .')}. ${u.transport.clickToReset}`}
        onClick={() => songActions.resetPitch()}
      />
      <Value
        label={u.loop}
        value={
          loopSet
            ? p.loop.on
              ? `${fmtTime(p.loop.start)}–${fmtTime(p.loop.end)}`
              : t.common.off
            : p.loop.start > 0
              ? u.transport.loopFrom(fmtTime(p.loop.start))
              : t.common.none
        }
        on={loopOn}
        title={`${withKey(u.transport.loopEnds, 'A B')} · ${withKey(u.transport.loopOnOff, 'R')} · ${withKey(u.loopSection, 'Q')}`}
        onClick={() => songActions.toggleLoop()}
      />
      {loopOn &&
        (repeat ? (
          <RepeatButton />
        ) : (
          <button type="button" className="btn btn--quiet" title={withKey(u.repeat, 'Shift+R')} onClick={() => funActions.toggleRepeat()}>
            {u.repeat}
          </button>
        ))}
      {(loopOn || trainer) && (
        <button
          type="button"
          className={`btn ${trainer ? 'btn--on' : 'btn--quiet'}`}
          title={withKey(u.transport.trainerTip, 'Shift+=')}
          onClick={() => funActions.toggleSpeedTrainer()}
        >
          {u.trainer}
        </button>
      )}
      <div className="transport__tags">
        {tags.map((tag) => (
          <button key={tag.text} type="button" className="tag tag--button" title={tag.title} onClick={tag.onClick}>
            {tag.text}
          </button>
        ))}
      </div>
      <Volumes />
      <span className="transport__sep" aria-hidden="true" />
      <button
        type="button"
        className="btn"
        aria-pressed={neckShown && !mixerOpen && !settingsOpen}
        title={`${withKey(u.fretboard, 'F')} · ${withKey(u.transport.neckShows, 'Shift+F')}`}
        onClick={() => songActions.toggleNeck()}
      >
        {u.fretboard}
      </button>
      <button
        type="button"
        className={`btn${stems?.tone === 'error' ? ' btn--cold' : ''}`}
        aria-pressed={mixerOpen}
        title={stems?.text ?? u.transport.stemsTip}
        onClick={() => songActions.toggleMixer()}
      >
        {u.stems}
      </button>
      <button type="button" className="btn" aria-pressed={settingsOpen} title={u.transport.settingsTip} onClick={() => songActions.toggleSettings()}>
        {SETTINGS}
        {u.settings}
      </button>
    </footer>
  );
}
