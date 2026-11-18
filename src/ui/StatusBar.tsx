import { ChevronLeft, ChevronRight } from 'lucide-react';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { presetName } from '../state/presets';
import { useLibrary } from '../state/library';
import { useRuntime } from '../state/runtime';
import { currentPreset, useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { latencyBadgeTitle, latencyTotalText } from './guitarInput';
import { LevelMeter } from './LevelMeter';
import { separationText } from './Mixer';

/** What the program is doing with songs right now, in one short line; null when nothing. */
function Jobs() {
  const t = useLang();
  const song = useSong((s) => s.song);
  const queue = useRuntime((s) => s.queue);
  const importing = useLibrary((s) => s.importing);
  const stems = song ? separationText(song) : null;
  const phase = importing && t.library.importPhase[importing.phase];
  if (importing && phase) {
    return (
      <span className="status__job">
        {t.library.importing(importing.name, phase)}
        {importing.phase === 'upload' && <span className="num"> {t.common.units.pct(Math.round(importing.progress * 100))}</span>}
      </span>
    );
  }
  if (stems && stems.tone !== 'idle') {
    return <span className={`status__job${stems.tone === 'error' ? ' status__job--cold' : ''}`}>{stems.text}</span>;
  }
  if (queue) {
    return <span className="status__job">{queue.kind === 'set' ? t.shell.setlistPlace(queue.index + 1, queue.ids.length) : t.shell.radio}</span>;
  }
  return null;
}

/**
 * The strip at the bottom of every screen: the guitar's input level and its preset (the arrows
 * flip presets, a click opens the amp), what the program is busy with, and on the right the path
 * the guitar takes with its latency (a click opens the settings).
 */
export function StatusBar() {
  const t = useLang();
  const preset = useSettings(currentPreset);
  const index = useSettings((s) => s.presetIndex);
  const step = useSettings((s) => s.stepPreset);
  const muted = useRuntime((s) => s.muted);
  const status = useRuntime((s) => s.status);
  const path = useRuntime((s) => s.guitarPath);
  const latency = useRuntime((s) => s.latency);
  const device = useRuntime((s) => s.native.state?.device ?? null);
  const patch = useRuntime((s) => s.patch);
  const running = status === 'running';

  return (
    <footer className="status">
      <span className="status__group" title={t.input.meter}>
        <LevelMeter size="compact" />
      </span>
      <span className="status__group status__preset">
        <button type="button" className="status__step" aria-label={t.shell.presetPrev} title={withKey(t.shell.presetPrev, 'PgUp')} onClick={() => step(-1)}>
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="status__btn" title={withKey(t.shell.openAmp, 'K')} onClick={() => patch({ view: 'amp' })}>
          <span className="status__no num">{index + 1}</span>
          {presetName(preset, t.amp.presets)}
        </button>
        <button type="button" className="status__step" aria-label={t.shell.presetNext} title={withKey(t.shell.presetNext, 'PgDn')} onClick={() => step(1)}>
          <ChevronRight size={14} />
        </button>
      </span>
      {muted && (
        <button type="button" className="tag tag--cold" title={withKey(t.shell.guitarMuted, 'M')} onClick={() => patch({ muted: false })}>
          {t.shell.guitarMuted}
        </button>
      )}
      <span className="status__gap" />
      <Jobs />
      <button
        type="button"
        className="status__btn status__path"
        title={running && latency ? `${latencyBadgeTitle(path)}${device ? ` · ${device}` : ''}` : withKey(t.shell.screens.input, 'I')}
        onClick={() => patch({ view: 'input' })}
      >
        {running ? (
          <>
            <i className="status__led" data-on={path !== null} aria-hidden="true" />
            {path === 'native' ? t.input.asio : t.input.systemAudio}
            {latency && <span className="num">{latencyTotalText(latency, path)}</span>}
          </>
        ) : (
          t.shell.soundOff
        )}
      </button>
    </footer>
  );
}
