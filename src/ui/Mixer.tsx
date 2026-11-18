import { Download, X } from 'lucide-react';
import { useRef, type CSSProperties } from 'react';
import { L, withKey } from '../i18n';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { readyModels, songActions } from '../song/actions';
import { songPlayer } from '../song/player';
import { isTabSong, STEMS, MODEL_NAMES, type ModelId, type Song, type Stem } from '../song/types';
import { useLibrary } from '../state/library';
import { useSong } from '../state/song';
import { Segmented, fmtDb } from './controls';
import { useEngineFrame } from './useEngineFrame';

const VOLUME_MIN_DB = -30;
const VOLUME_MAX_DB = 6;
/** The meters' bottom, dBFS: a stem under it shows nothing. */
const METER_FLOOR_DB = -54;

/** What is being done with this song's stems, in words (the current language, at call time). */
export function separationText(song: Song): { text: string; tone: 'busy' | 'error' | 'idle' } | null {
  if (isTabSong(song)) return null; // its parts are its stems: nothing to separate
  const words = L().songUi.mixer;
  const entries = Object.entries(song.stems) as [ModelId, NonNullable<Song['stems'][ModelId]>][];
  const running = entries.find(([, info]) => info.status === 'running');
  if (running) return { text: words.separating(Math.round((running[1].progress ?? 0) * 100)), tone: 'busy' };
  const queued = entries.find(([, info]) => info.status === 'queued');
  if (queued) return { text: words.waiting, tone: 'busy' };
  const failed = entries.find(([, info]) => info.status === 'error');
  if (failed && !readyModels(song.stems).length) return { text: messageText(failed[1].error) || words.failed, tone: 'error' };
  if (!entries.length) return { text: words.notSeparated, tone: 'idle' };
  return null;
}

/** One channel of the console: its colour and name, mute and solo, a fader with a live meter beside it. */
function Strip({ song, stem, meter }: { song: Song; stem: Stem; meter: (el: HTMLElement | null) => void }) {
  const t = useLang();
  const m = t.songUi.mixer;
  const updatePlayer = useSong((s) => s.updatePlayer);
  const p = song.player;
  const muted = p.muted.includes(stem);
  const soloed = p.solo === stem;
  const silent = p.solo ? !soloed : muted;
  const isGuitar = stem === 'guitar';
  // In a tab-song «guitar» is the part on screen, whatever it is.
  const name = isGuitar && isTabSong(song) ? m.yourPart : t.songUi.stemNames[stem];
  return (
    <div className={`strip${silent ? ' strip--silent' : ''}`} style={{ '--stem': `var(--stem-${stem})` } as CSSProperties}>
      <span className="strip__name" title={name}>
        {name}
      </span>
      <div className="strip__ms">
        <button
          type="button"
          className={`strip__btn${muted ? ' is-on' : ''}`}
          aria-pressed={muted}
          aria-label={m.mute}
          title={isGuitar ? withKey(m.muteTip, 'G') : m.muteTip}
          onClick={() =>
            isGuitar
              ? songActions.toggleGuitar()
              : updatePlayer({ muted: muted ? p.muted.filter((s) => s !== stem) : [...p.muted, stem] })
          }
        >
          M
        </button>
        <button
          type="button"
          className={`strip__btn strip__btn--solo${soloed ? ' is-on' : ''}`}
          aria-pressed={soloed}
          aria-label={m.solo}
          title={isGuitar ? withKey(m.soloTip, 'S') : m.soloTip}
          onClick={() => (isGuitar ? songActions.soloGuitar() : updatePlayer({ solo: soloed ? null : stem }))}
        >
          S
        </button>
      </div>
      <div className="strip__fader">
        <span className="strip__meter" aria-hidden="true">
          <i ref={meter} />
        </span>
        <input
          type="range"
          className="fader"
          aria-label={m.volumeOf(name)}
          min={VOLUME_MIN_DB}
          max={VOLUME_MAX_DB}
          step={1}
          value={p.volumesDb[stem]}
          onChange={(e) => updatePlayer({ volumesDb: { ...p.volumesDb, [stem]: Number(e.target.value) } })}
          onDoubleClick={() => updatePlayer({ volumesDb: { ...p.volumesDb, [stem]: 0 } })}
        />
      </div>
      <span className="strip__db num">{fmtDb(p.volumesDb[stem])}</span>
    </div>
  );
}

/**
 * The mixer under the view, like a console: a channel per stem with its level moving, mute, solo
 * and a fader (double-click: back to 0 dB). The head has the stem model when there are two, and
 * the backing track.
 */
export function Mixer({ song, onClose }: { song: Song; onClose: () => void }) {
  const t = useLang();
  const u = t.songUi;
  const source = useSong((s) => s.source);
  const updateSong = useSong((s) => s.updateSong);
  const health = useLibrary((s) => s.health);
  const status = separationText(song);
  const ready = readyModels(song.stems);
  const stemsPlaying = source !== null && source !== 'mix';
  const meters = useRef<Partial<Record<Stem, HTMLElement | null>>>({});
  const shown = useRef<Partial<Record<Stem, number>>>({});

  // The meters fall slower than they rise, like a console's.
  useEngineFrame(() => {
    for (const stem of STEMS) {
      const el = meters.current[stem];
      if (!el) continue;
      const db = songPlayer.readStemDb(stem);
      const level = Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
      const next = Math.max(level, (shown.current[stem] ?? 0) - 0.03);
      if (Math.abs(next - (shown.current[stem] ?? 0)) < 0.004) continue;
      shown.current[stem] = next;
      el.style.transform = `scaleY(${next.toFixed(3)})`;
    }
  });

  return (
    <section className="mixer" aria-label={u.stems}>
      <div className="panel-head">
        <span className="panel-head__title">{u.stems}</span>
        {isTabSong(song) && (
          <span className="caption" title={withKey(u.nextPart, "'")}>
            {u.mixer.tabPartHint}
          </span>
        )}
        {ready.length > 1 && song.activeModel && (
          <span title={withKey(u.nextModel, 'N')}>
            <Segmented<ModelId>
              label={u.stemModel}
              value={song.activeModel}
              options={ready.map((m) => ({ value: m, label: MODEL_NAMES[m] }))}
              onChange={(activeModel) => updateSong({ activeModel })}
            />
          </span>
        )}
        {!isTabSong(song) && (
          <button type="button" className="btn btn--sm btn--ghost" title={withKey(u.exportBacking, 'E')} onClick={() => void songActions.exportBacking()}>
            <Download size={14} />
            {u.exportBacking}
          </button>
        )}
        <button type="button" className="iconbtn iconbtn--sm" aria-label={t.common.close} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {status && (
        <p className={`mixer__status mixer__status--${status.tone}`}>
          {status.text}
          {!stemsPlaying && status.tone === 'busy' && ` ${u.mixer.wholeSongPlays}`}
          {status.tone !== 'busy' && health && (
            <button type="button" className="btn btn--sm" onClick={() => void songActions.separate(song.id, health.defaultModel)}>
              {status.tone === 'error' ? t.common.retry : u.mixer.separate}
            </button>
          )}
        </p>
      )}
      {stemsPlaying && (
        <div className="strips">
          {STEMS.map((stem) => (
            <Strip key={stem} song={song} stem={stem} meter={(el) => void (meters.current[stem] = el)} />
          ))}
        </div>
      )}
    </section>
  );
}
