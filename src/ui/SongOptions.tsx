import { BookmarkPlus, ChevronLeft, ChevronRight, Download, Maximize, Minus, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { TUNING_ORDER, TUNINGS } from '../music/tunings';
import { readyModels, songActions } from '../song/actions';
import { fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { MIN_LOOP } from '../song/schedule';
import { textActions } from '../song/textActions';
import { isTabSong, MODEL_NAMES, type ModelId, type Song, type TuningId } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { Toggle } from './controls';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="opts__group">
      <h3 className="opts__title">{title}</h3>
      {children}
    </section>
  );
}

/** A row: what it is on the left, its control on the right; the key is in the tooltip. */
function Row({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <div className="row" title={keys ? withKey(label, keys) : undefined}>
      <span className="row__label">{label}</span>
      <span className="row__control">{children}</span>
    </div>
  );
}

function Switch({ label, keys, on, hint, onChange }: { label: string; keys?: string; on: boolean; hint?: string; onChange: () => void }) {
  return <Toggle label={label} on={on} hint={hint ? (keys ? withKey(hint, keys) : hint) : keys ? withKey(label, keys) : undefined} onChange={onChange} />;
}

/**
 * The song's options, in a panel on the right of the player: every switch of the song as a real
 * control, in groups. Nothing here is needed while playing, which is why it is folded away; what
 * is on shows in the transport. Keys are in the tooltips and on the Keys sheet.
 */
export function SongOptions({ song }: { song: Song }) {
  const t = useLang();
  const u = t.songUi;
  const s = u.options;
  const repeat = useRuntime((st) => st.repeat);
  const trainer = useRuntime((st) => st.speedTrainer);
  const degrees = useSettings((st) => st.degrees);
  const p = song.player;
  const ear = p.mode === 'ear';
  const loopSet = p.loop.end - p.loop.start >= MIN_LOOP;
  const guitarOn = !p.muted.includes('guitar');
  const models = readyModels(song.stems);
  const tabSong = isTabSong(song);

  return (
    <aside className="opts" aria-label={s.label}>
      <div className="panel-head">
        <span className="panel-head__title">{s.label}</span>
        <button type="button" className="iconbtn iconbtn--sm" aria-label={t.common.close} title={withKey(t.common.close, 'Esc')} onClick={() => songActions.toggleSettings()}>
          <X size={14} />
        </button>
      </div>
      <div className="opts__body">
        <Group title={s.groupPlaying}>
          <Switch label={u.countIn} keys="O" on={p.countIn} hint={s.countInHint} onChange={() => songActions.toggleCountIn()} />
          <Switch label={u.click} keys="C" on={p.click} hint={s.clickHint} onChange={() => songActions.toggleClick()} />
          <Switch label={s.byEar} keys="H" on={ear} hint={s.byEarHint} onChange={() => songActions.toggleMode()} />
          {ear && (
            <Row label={u.hint} keys="J">
              <span className="opts__value">{u.hintsLong[p.reveal]}</span>
              <button type="button" className="btn btn--sm" onClick={() => songActions.nextHint()}>
                {u.transport.nextHint}
              </button>
            </Row>
          )}
        </Group>

        <Group title={s.groupChords}>
          <Row label={u.capo} keys="[ ]">
            <span className={`stepper${p.capo ? ' is-on' : ''}`}>
              <button type="button" aria-label={s.capoDown} disabled={p.capo <= 0} onClick={() => songActions.stepCapo(-1)}>
                <Minus size={14} />
              </button>
              <span className="stepper__value">{p.capo ? s.capoValue(p.capo) : t.common.none}</span>
              <button type="button" aria-label={s.capoUp} onClick={() => songActions.stepCapo(1)}>
                <Plus size={14} />
              </button>
            </span>
          </Row>
          <Row label={u.tuning} keys="U">
            <select
              className="sel"
              value={p.tuning}
              aria-label={u.tuning}
              onChange={(e) => {
                useSong.getState().updatePlayer({ tuning: e.target.value as TuningId });
                e.target.blur(); // give the keys back to the shortcuts
              }}
            >
              {TUNING_ORDER.map((id) => (
                <option key={id} value={id}>
                  {TUNINGS[id].name}
                </option>
              ))}
            </select>
          </Row>
          <Switch label={u.simpleChords} keys="P" on={p.simpleChords} hint={s.simpleHint} onChange={() => songActions.toggleSimple()} />
          <Switch label={s.degrees} keys="D" on={degrees} hint={s.degreesHint} onChange={() => useSettings.getState().toggleDegrees()} />
          <Row label={s.barLines} keys="Shift+[ ]">
            <button type="button" className="iconbtn" aria-label={s.barsEarlier} title={s.barsEarlier} onClick={() => songActions.shiftBars(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="iconbtn" aria-label={s.barsLater} title={s.barsLater} onClick={() => songActions.shiftBars(1)}>
              <ChevronRight size={16} />
            </button>
          </Row>
        </Group>

        <Group title={s.groupSound}>
          <Switch label={u.matchTone} keys="Y" on={p.toneMatch} hint={s.matchToneHint} onChange={() => songActions.toggleToneMatch()} />
          <Switch
            label={tabSong ? u.mixer.yourPart : u.originalGuitar}
            keys="G"
            on={guitarOn}
            hint={tabSong ? undefined : u.originalGuitarTip}
            onChange={() => songActions.toggleGuitar()}
          />
          <Switch label={u.guitarOnly} keys="S" on={p.solo === 'guitar'} onChange={() => songActions.soloGuitar()} />
          {models.length > 1 && song.activeModel && (
            <Row label={u.stemModel} keys="N">
              <select
                className="sel"
                value={song.activeModel}
                aria-label={u.stemModel}
                onChange={(e) => {
                  useSong.getState().updateSong({ activeModel: e.target.value as ModelId });
                  e.target.blur();
                }}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {MODEL_NAMES[m]}
                  </option>
                ))}
              </select>
            </Row>
          )}
        </Group>

        <Group title={u.loop}>
          <Row label={u.loop} keys="R">
            {loopSet && (
              <span className="opts__value num">
                {fmtTime(p.loop.start)}–{fmtTime(p.loop.end)}
              </span>
            )}
            <Toggle label="" on={loopSet && p.loop.on} onChange={() => songActions.toggleLoop()} />
          </Row>
          <Switch label={u.repeat} keys="Shift+R" on={repeat} hint={s.repeatHint} onChange={() => funActions.toggleRepeat()} />
          <Switch label={u.trainer} keys="Shift+=" on={trainer} hint={u.transport.trainerTip} onChange={() => funActions.toggleSpeedTrainer()} />
          <div className="opts__buttons">
            <button type="button" className="btn btn--sm" title={withKey(u.loopSection, 'Q')} onClick={() => songActions.loopSection()}>
              {u.loopSection}
            </button>
            <button type="button" className="btn btn--sm" title={withKey(s.bookmarkLoop, 'Z')} onClick={() => songActions.addBookmark()}>
              <BookmarkPlus size={14} />
              {s.bookmarkLoop}
            </button>
          </div>
          {p.bookmarks.map((mark, i) => (
            <div key={`${mark.start}-${mark.end}-${i}`} className="opts__mark">
              <button type="button" className="opts__go" title={withKey(s.nextBookmark, 'X')} onClick={() => songActions.goToBookmark(i)}>
                <span className="opts__markname">{mark.name}</span>
                <span className="num">
                  {fmtTime(mark.start)}–{fmtTime(mark.end)}
                </span>
              </button>
              <button type="button" className="iconbtn iconbtn--sm" aria-label={s.deleteBookmark(mark.name)} title={s.deleteBookmark(mark.name)} onClick={() => songActions.removeBookmark(i)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </Group>

        <Group title={s.groupMore}>
          <div className="opts__buttons">
            <button type="button" className="btn btn--sm" title={withKey(u.stageView, u.stageKey)} onClick={() => textActions.toggleStage()}>
              <Maximize size={14} />
              {u.stageView}
            </button>
            {!tabSong && (
              <button type="button" className="btn btn--sm" title={withKey(u.exportBacking, 'E')} onClick={() => void songActions.exportBacking()}>
                <Download size={14} />
                {u.exportBacking}
              </button>
            )}
          </div>
        </Group>
      </div>
    </aside>
  );
}
