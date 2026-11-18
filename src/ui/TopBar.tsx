import { Mark } from './Mark';
import { useEffect, useState } from 'react';
import { APP_NAME, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { keyName, keySpelling } from '../music/keys';
import { recorder } from '../record/recorder';
import { fmtTime } from '../song/format';
import { presetName } from '../state/presets';
import { useRuntime, type View } from '../state/runtime';
import { currentPreset, useSettings } from '../state/settings';
import { useSong } from '../state/song';
import { useTakes } from '../state/takes';
import { soundingKey } from './Fretboard';
import { LevelMeter } from './LevelMeter';
import { separationText } from './Mixer';

const SCREENS: { view: View; key: string }[] = [
  { view: 'song', key: 'Esc' },
  { view: 'library', key: 'L' },
  { view: 'amp', key: 'K' },
  { view: 'input', key: 'I' },
];

/** The open song in the middle: title, artist, tempo and key, and what the service is doing with it. */
function SongTitle() {
  const song = useSong((s) => s.song);
  const analysis = useSong((s) => s.analysis);
  const state = useSong((s) => s.state);
  const queue = useRuntime((s) => s.queue);
  const t = useLang();
  if (!song) return <div className="topbar__song" />;
  const key = soundingKey(analysis, song);
  const facts = [
    analysis?.tempo ? `${Math.round(analysis.tempo * song.player.speed)} BPM` : '',
    key ? keyName(key, keySpelling(key)) : '',
  ].filter(Boolean);
  const stems = separationText(song);
  const status =
    state === 'loading'
      ? t.common.loading
      : stems?.tone === 'busy' || stems?.tone === 'error'
        ? stems.text
        : queue
          ? queue.kind === 'set'
            ? t.shell.setlistPlace(queue.index + 1, queue.ids.length)
            : t.shell.radio
          : '';
  return (
    <div className="topbar__song">
      <span className="topbar__title">{song.title}</span>
      {song.artist && <span className="topbar__artist">{song.artist}</span>}
      {facts.length > 0 && <span className="topbar__facts num">{facts.join(' · ')}</span>}
      {status && <span className={`topbar__status${stems?.tone === 'error' ? ' topbar__status--cold' : ''}`}>{status}</span>}
    </div>
  );
}

/** «Запись» (\): a quiet button; while recording, a dot and the time, pressed to stop. */
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
      className={`btn btn--quiet topbar__rec${recording ? ' topbar__rec--on' : ''}`}
      aria-pressed={!!recording}
      disabled={saving}
      title={withKey(recording ? t.shell.recordStop : t.shell.recordStart, '\\')}
      onClick={() => recorder.toggle()}
    >
      <i aria-hidden="true" />
      {saving ? t.common.saving : recording ? <span className="num">{fmtTime(seconds)}</span> : t.shell.record}
    </button>
  );
}

/**
 * One quiet line on top of every screen: the screens, the open song, the tuner (T) and the
 * preset with the guitar's level (a click opens «Комбик»).
 */
export function TopBar() {
  const preset = useSettings(currentPreset);
  const view = useRuntime((s) => s.view);
  const muted = useRuntime((s) => s.muted);
  const bigTuner = useRuntime((s) => s.bigTuner);
  const keysOpen = useRuntime((s) => s.keysOpen);
  const patch = useRuntime((s) => s.patch);
  const t = useLang();

  return (
    <header className="topbar">
      <div className="topbar__left">
        <span className="topbar__logo">
          <Mark className="topbar__mark" />
          {APP_NAME}
        </span>
        <nav className="topbar__nav" aria-label={t.shell.screensLabel}>
          {SCREENS.map((s) => (
            <button
              key={s.view}
              type="button"
              aria-current={view === s.view}
              title={withKey(t.shell.screens[s.view], s.key)}
              onClick={() => patch({ view: s.view })}
            >
              {t.shell.screens[s.view]}
            </button>
          ))}
        </nav>
      </div>
      <SongTitle />
      <div className="topbar__right">
        {muted && (
          <span className="tag tag--cold" title={withKey(t.shell.guitarMuted, 'M')}>
            {t.shell.guitarMuted}
          </span>
        )}
        <RecordButton />
        <button
          type="button"
          className="btn btn--quiet"
          aria-pressed={keysOpen}
          title={withKey(t.keys.open, 'F1')}
          onClick={() => patch({ keysOpen: !keysOpen })}
        >
          {t.keys.open}
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          aria-pressed={bigTuner}
          title={withKey(t.shell.tuner, 'T')}
          onClick={() => patch({ bigTuner: !bigTuner })}
        >
          {t.shell.tuner}
        </button>
        <button
          type="button"
          className="btn btn--quiet topbar__preset"
          title={`${withKey(t.shell.screens.amp, 'K')} · ${withKey(t.shell.presets, 'PgUp / PgDn')}`}
          onClick={() => patch({ view: 'amp' })}
        >
          <LevelMeter size="compact" />
          {presetName(preset, t.amp.presets)}
        </button>
      </div>
    </header>
  );
}
