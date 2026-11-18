import type { ReactNode } from 'react';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { TUNINGS } from '../music/tunings';
import { readyModels, songActions } from '../song/actions';
import { fmtTime } from '../song/format';
import { funActions } from '../song/funActions';
import { MIN_LOOP } from '../song/schedule';
import { textActions } from '../song/textActions';
import { MODEL_NAMES, type Song } from '../song/types';
import { useRuntime } from '../state/runtime';
import { useSettings } from '../state/settings';

/** One switch: what it is, its value now (warm when on), and its key. */
function Opt({ label, value, on = false, keys, onClick }: { label: string; value: string; on?: boolean; keys: string; onClick?: () => void }) {
  return (
    <button type="button" className="opt" onClick={onClick} disabled={!onClick}>
      <span className="opt__label">{label}</span>
      <span className={`opt__value${on ? ' opt__value--on' : ''}`}>{value}</span>
      <kbd>{keys}</kbd>
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="opts__group">
      <h3 className="opts__title">{title}</h3>
      {children}
    </div>
  );
}

/**
 * «Настройки» of the song, in the neck's place: every switch with its value and key (this list is
 * where the keys are learned; the rest are on the Keys sheet). Nothing here is needed while
 * playing — that is why it is folded away.
 */
export function SongSettings({ song }: { song: Song }) {
  const t = useLang();
  const u = t.songUi;
  const s = u.options;
  const onOff = (on: boolean) => (on ? t.common.on : t.common.off);
  const repeat = useRuntime((st) => st.repeat);
  const trainer = useRuntime((st) => st.speedTrainer);
  const neckView = useSettings((st) => st.neckView);
  const degrees = useSettings((st) => st.degrees);
  const p = song.player;
  const ear = p.mode === 'ear';
  const loopSet = p.loop.end - p.loop.start >= MIN_LOOP;
  const guitarOn = !p.muted.includes('guitar');
  const models = readyModels(song.stems);
  return (
    <section className="opts" aria-label={s.label}>
      <Group title={s.groupPlaying}>
        <Opt label={s.mode} value={ear ? s.modeEar : s.modePlay} on={ear} keys="H" onClick={() => songActions.toggleMode()} />
        {ear && <Opt label={u.hint} value={u.hintsLong[p.reveal]} on={p.reveal > 0} keys="J" onClick={() => songActions.nextHint()} />}
        <Opt label={u.countIn} value={onOff(p.countIn)} on={p.countIn} keys="O" onClick={() => songActions.toggleCountIn()} />
        <Opt label={u.click} value={onOff(p.click)} on={p.click} keys="C" onClick={() => songActions.toggleClick()} />
        <Opt label={u.stageView} value="" keys={u.stageKey} onClick={() => textActions.toggleStage()} />
      </Group>
      <Group title={s.groupChords}>
        <Opt
          label={u.capo}
          value={p.capo ? s.capoValue(p.capo) : t.common.none}
          on={p.capo > 0}
          keys="[ ]"
          onClick={() => songActions.stepCapo(p.capo >= 9 ? -1 : 1)}
        />
        <Opt label={u.tuning} value={TUNINGS[p.tuning].name.toLowerCase()} on={p.tuning !== 'standard'} keys="U" onClick={() => songActions.nextTuning()} />
        <Opt label={u.simpleChords} value={onOff(p.simpleChords)} on={p.simpleChords} keys="P" onClick={() => songActions.toggleSimple()} />
        <Opt
          label={s.neckShows}
          value={u.neckViews[neckView]}
          keys="Shift+F"
          onClick={() => {
            useSettings.getState().stepNeckView();
            songActions.showNeck();
          }}
        />
        <Opt label={s.degrees} value={onOff(degrees)} on={degrees} keys="D" onClick={() => useSettings.getState().toggleDegrees()} />
      </Group>
      <Group title={s.groupSound}>
        <Opt label={u.matchTone} value={onOff(p.toneMatch)} on={p.toneMatch} keys="Y" onClick={() => songActions.toggleToneMatch()} />
        <Opt
          label={u.originalGuitar}
          value={guitarOn ? s.guitarPlays : s.guitarSilent}
          on={guitarOn}
          keys="G"
          onClick={() => songActions.toggleGuitar()}
        />
        <Opt label={u.guitarOnly} value={onOff(p.solo === 'guitar')} on={p.solo === 'guitar'} keys="S" onClick={() => songActions.soloGuitar()} />
        {models.length > 1 && song.activeModel && (
          <Opt label={u.stemModel} value={MODEL_NAMES[song.activeModel]} keys="N" onClick={() => songActions.nextModel()} />
        )}
        <Opt label={u.exportBacking} value="" keys="E" onClick={() => void songActions.exportBacking()} />
      </Group>
      <Group title={u.loop}>
        <Opt
          label={u.loop}
          value={loopSet ? onOff(p.loop.on) : t.common.none}
          on={loopSet && p.loop.on}
          keys="A B R"
          onClick={() => songActions.toggleLoop()}
        />
        <Opt label={u.loopSection} value="" keys="Q" onClick={() => songActions.loopSection()} />
        <Opt label={u.repeat} value={onOff(repeat)} on={repeat} keys="Shift+R" onClick={() => funActions.toggleRepeat()} />
        <Opt label={u.trainer} value={onOff(trainer)} on={trainer} keys="Shift+=" onClick={() => funActions.toggleSpeedTrainer()} />
        <Opt label={s.bookmarkLoop} value="" keys="Z" onClick={() => songActions.addBookmark()} />
        {p.bookmarks.map((mark, i) => (
          <div key={`${mark.start}-${mark.end}-${i}`} className="opt opt--mark">
            <button type="button" className="opt__go" title={withKey(s.nextBookmark, 'X')} onClick={() => songActions.goToBookmark(i)}>
              {mark.name}
            </button>
            <span className="opt__value num">
              {fmtTime(mark.start)}–{fmtTime(mark.end)}
            </span>
            <button type="button" className="opt__x" aria-label={s.deleteBookmark(mark.name)} onClick={() => songActions.removeBookmark(i)}>
              ×
            </button>
          </div>
        ))}
      </Group>
    </section>
  );
}
