import { AudioLines, Keyboard, ListMusic, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { APP_NAME, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { recorder } from '../record/recorder';
import { fmtTime } from '../song/format';
import { useRuntime, type View } from '../state/runtime';
import { useTakes } from '../state/takes';
import { IconAmp, IconRecord, IconRecordStop, IconTuner } from './icons';
import { Mark } from './Mark';

const SCREENS: { view: View; key: string; icon: LucideIcon }[] = [
  { view: 'song', key: 'Esc', icon: AudioLines },
  { view: 'library', key: 'L', icon: ListMusic },
  { view: 'amp', key: 'K', icon: IconAmp },
];

/** Record (\): the dot; while recording, the time, pressed again to stop and save. */
function RecordButton() {
  const recording = useTakes((s) => s.recording);
  const saving = useTakes((s) => s.saving);
  const t = useLang();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [recording]);
  const seconds = recording ? Math.max(0, (performance.now() - recording.startedAt) / 1000) : 0;
  return (
    <button
      type="button"
      className={`rail__item rail__rec${recording ? ' rail__rec--on' : ''}`}
      aria-pressed={!!recording}
      disabled={saving}
      title={withKey(recording ? t.shell.recordStop : t.shell.recordStart, '\\')}
      onClick={() => recorder.toggle()}
    >
      {recording ? <IconRecordStop size={20} /> : <IconRecord size={20} />}
      <span className={recording ? 'num' : undefined}>{saving ? t.common.saving : recording ? fmtTime(seconds) : t.shell.record}</span>
    </button>
  );
}

/**
 * The narrow panel on the left of every screen: the screens on top (Player, Songs, Amp), the tools
 * at the bottom (tuner, record, keys, settings). Each is an icon with its word under it.
 */
export function Rail() {
  const view = useRuntime((s) => s.view);
  const bigTuner = useRuntime((s) => s.bigTuner);
  const keysOpen = useRuntime((s) => s.keysOpen);
  const patch = useRuntime((s) => s.patch);
  const t = useLang();

  return (
    <nav className="rail" aria-label={t.shell.screensLabel}>
      <span className="rail__logo" title={APP_NAME}>
        <Mark className="rail__mark" />
      </span>
      {SCREENS.map((s) => (
        <button
          key={s.view}
          type="button"
          className="rail__item"
          aria-current={view === s.view}
          title={withKey(t.shell.screens[s.view], s.key)}
          onClick={() => patch({ view: s.view })}
        >
          <s.icon size={20} />
          <span>{t.shell.screens[s.view]}</span>
        </button>
      ))}
      <span className="rail__gap" />
      <button
        type="button"
        className="rail__item"
        aria-pressed={bigTuner}
        title={withKey(t.shell.tuner, 'T')}
        onClick={() => patch({ bigTuner: !bigTuner })}
      >
        <IconTuner size={20} />
        <span>{t.shell.tuner}</span>
      </button>
      <RecordButton />
      <button
        type="button"
        className="rail__item"
        aria-pressed={keysOpen}
        title={withKey(t.keys.title, 'F1')}
        onClick={() => patch({ keysOpen: !keysOpen })}
      >
        <Keyboard size={20} />
        <span>{t.keys.open}</span>
      </button>
      <button
        type="button"
        className="rail__item"
        aria-current={view === 'input'}
        title={withKey(t.shell.screens.input, 'I')}
        onClick={() => patch({ view: view === 'input' ? 'song' : 'input' })}
      >
        <Settings size={20} />
        <span>{t.shell.screens.input}</span>
      </button>
    </nav>
  );
}
