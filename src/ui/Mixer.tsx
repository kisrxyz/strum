import { L, withKey } from '../i18n';
import { messageText } from '../i18n/messages';
import { useLang } from '../i18n/useLang';
import { readyModels, songActions } from '../song/actions';
import { isTabSong, STEMS, MODEL_NAMES, type ModelId, type Song, type Stem } from '../song/types';
import { useLibrary } from '../state/library';
import {
  GUITAR_VOLUME_MAX_DB,
  GUITAR_VOLUME_MIN_DB,
  SONG_VOLUME_MAX_DB,
  SONG_VOLUME_MIN_DB,
  useSettings,
} from '../state/settings';
import { useSong } from '../state/song';
import { Segmented, fmtDb } from './controls';

const VOLUME_MIN_DB = -30;
const VOLUME_MAX_DB = 6;

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

function Strip({ song, stem }: { song: Song; stem: Stem }) {
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
    <div className={`strip${silent ? ' strip--silent' : ''}${isGuitar ? ' strip--guitar' : ''}`}>
      <span className="strip__top">
        <span className="strip__name">{name}</span>
        {isGuitar && <span className="strip__you">{muted && !p.solo ? m.you : m.original}</span>}
        <span className="strip__db">{fmtDb(p.volumesDb[stem])}</span>
      </span>
      <input
        type="range"
        aria-label={m.volumeOf(name)}
        min={VOLUME_MIN_DB}
        max={VOLUME_MAX_DB}
        step={1}
        value={p.volumesDb[stem]}
        onChange={(e) => updatePlayer({ volumesDb: { ...p.volumesDb, [stem]: Number(e.target.value) } })}
      />
      <div className="strip__buttons">
        <button
          type="button"
          className={`stripbtn${muted ? ' stripbtn--on' : ''}`}
          aria-pressed={muted}
          title={isGuitar ? withKey(m.muteTip, 'G') : m.muteTip}
          onClick={() =>
            isGuitar
              ? songActions.toggleGuitar()
              : updatePlayer({ muted: muted ? p.muted.filter((s) => s !== stem) : [...p.muted, stem] })
          }
        >
          {m.mute}
        </button>
        <button
          type="button"
          className={`stripbtn${soloed ? ' stripbtn--on' : ''}`}
          aria-pressed={soloed}
          title={isGuitar ? withKey(m.soloTip, 'S') : m.soloTip}
          onClick={() => (isGuitar ? songActions.soloGuitar() : updatePlayer({ solo: soloed ? null : stem }))}
        >
          {m.solo}
        </button>
      </div>
    </div>
  );
}

function Volume(props: { label: string; name: string; keys: string; db: number; min: number; max: number; onChange: (db: number) => void }) {
  return (
    <label className="vol" title={withKey(props.name, props.keys)}>
      <span className="vol__label">{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={1} value={props.db}
        aria-label={props.name} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="vol__db">{fmtDb(props.db)}</span>
    </label>
  );
}

/** «Гитара» and «Песня»: the two volumes one turns while playing, always in the song's status bar. */
export function Volumes() {
  const m = useLang().songUi.mixer;
  const guitarDb = useSettings((s) => s.guitarDb);
  const songDb = useSettings((s) => s.songVolumeDb);
  const setGuitarDb = useSettings((s) => s.setGuitarDb);
  const setSongDb = useSettings((s) => s.setSongVolumeDb);
  return (
    <span className="vols">
      <Volume label={m.guitar} name={m.guitarVolume} keys="Alt+↑ ↓" db={guitarDb} min={GUITAR_VOLUME_MIN_DB} max={GUITAR_VOLUME_MAX_DB} onChange={setGuitarDb} />
      <Volume label={m.song} name={m.songVolume} keys="Shift+↑ ↓" db={songDb} min={SONG_VOLUME_MIN_DB} max={SONG_VOLUME_MAX_DB} onChange={setSongDb} />
    </span>
  );
}

/** The stems' volumes, the model and the backing track (the song volume is in the status bar): opened from «Дорожки» in
 * the song's status bar, in the place of the fretboard. */
export function Mixer({ song, onClose }: { song: Song; onClose: () => void }) {
  const t = useLang();
  const u = t.songUi;
  const open = true;
  const source = useSong((s) => s.source);
  const updateSong = useSong((s) => s.updateSong);
  const health = useLibrary((s) => s.health);
  const status = separationText(song);
  const ready = readyModels(song.stems);
  const stemsPlaying = source !== null && source !== 'mix';

  return (
    <section className="mixer" aria-label={u.stems}>
      <div className="mixer__head">
        <h2>
          <button type="button" className="linkbtn mixer__fold" aria-expanded={open} onClick={onClose}>
            {u.stems} ▴
          </button>
        </h2>
        {open && ready.length > 1 && song.activeModel && (
          <span title={withKey(u.nextModel, 'N')}>
            <Segmented<ModelId>
              label={u.stemModel}
              value={song.activeModel}
              options={ready.map((m) => ({ value: m, label: MODEL_NAMES[m] }))}
              onChange={(activeModel) => updateSong({ activeModel })}
            />
          </span>
        )}
        {open && !isTabSong(song) && (
          <button type="button" className="ghostbtn" title={withKey(u.exportBacking, 'E')} onClick={() => void songActions.exportBacking()}>
            {u.exportBacking}
          </button>
        )}
        {open && isTabSong(song) && (
          <span className="mixer__hint" title={withKey(u.nextPart, "'")}>
            {u.mixer.tabPartHint}
          </span>
        )}
      </div>
      {status && (
        <p className={`mixer__status mixer__status--${status.tone}`}>
          {status.text}
          {!stemsPlaying && status.tone === 'busy' && ` ${u.mixer.wholeSongPlays}`}
          {status.tone !== 'busy' && health && (
            <button type="button" className="linkbtn" onClick={() => void songActions.separate(song.id, health.defaultModel)}>
              {status.tone === 'error' ? t.common.retry : u.mixer.separate}
            </button>
          )}
        </p>
      )}
      {stemsPlaying && open && (
        <div className="strips">
          {STEMS.map((stem) => (
            <Strip key={stem} song={song} stem={stem} />
          ))}
        </div>
      )}
    </section>
  );
}
