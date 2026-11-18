import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NO_INPUT } from '../audio/input';
import { nativeNoteText, textDriverStuck } from '../audio/native/session';
import type { ChannelMode } from '../dsp/channel';
import { driverStuck, rateLatency } from '../dsp/latency';
import { APP_NAME, withKey, type Lang } from '../i18n';
import { LANG_NAMES, LANGS } from '../i18n/lang';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';
import { NATIVE_BUFFERS, useSettings, type GuitarEngine, type LatencyMode } from '../state/settings';
import { Segmented, Toggle } from './controls';
import {
  bufferOptions,
  canGrowBuffer,
  clicksLine,
  clicksSince,
  fmtMs1,
  latencyAdvice,
  latencySource,
  latencyTotalText,
  nativeDeviceNames,
  pickerLayout,
  routeNote,
} from './guitarInput';
import { IconTuner } from './icons';
import { InputTrim } from './InputTrim';
import { LevelMeter } from './LevelMeter';
import { useEngineFrame } from './useEngineFrame';

declare const __STRUM_VERSION__: string;

/** Which channel of the card the guitar was found in, written when it changes. */
function ChannelNow() {
  const el = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  const t = useLang();
  // Another language: the next frame writes the words again.
  useEffect(() => {
    last.current = '';
  }, [t]);
  useEngineFrame((s) => {
    if (s.channel !== last.current && el.current) {
      last.current = s.channel;
      el.current.textContent = t.input.channelNow(t.input.channelNames[s.channel]);
    }
  });
  return <span ref={el} className="row__hint" />;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set">
      <h2 className="set__title">{title}</h2>
      <div className="set__rows">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row__label">
        {label}
        {typeof hint === 'string' ? <span className="row__hint">{hint}</span> : hint}
      </span>
      <span className="row__control">{children}</span>
    </div>
  );
}

/**
 * Settings (I): the sound first (driver, card, buffer, channel; the input level with its meter;
 * the latency, once), then the tuner's reference, the language, recording and About. On the first
 * start a strip on top says what to do here, with Done.
 */
export function SettingsScreen() {
  const s = useSettings();
  const inputs = useRuntime((r) => r.inputs);
  const outputs = useRuntime((r) => r.outputs);
  const canPickOutput = useRuntime((r) => r.canPickOutput);
  const activeLabel = useRuntime((r) => r.activeInputLabel);
  const latency = useRuntime((r) => r.latency);
  const sampleRate = useRuntime((r) => r.sampleRate);
  const guitarPath = useRuntime((r) => r.guitarPath);
  const nativeState = useRuntime((r) => r.native.state);
  const nativeNote = useRuntime((r) => r.native.note);
  const xruns = useRuntime((r) => r.native.stats?.xruns ?? 0);
  const patch = useRuntime((r) => r.patch);
  const t = useLang();
  const i = t.input;
  // The engine's dropout count when the card or the buffer was last changed here.
  const [clickBase, setClickBase] = useState(0);

  const done = () => {
    s.markSetupDone();
    patch({ view: 'song' });
  };

  const selectedInput = s.inputDeviceId ?? inputs.find((d) => d.label === activeLabel)?.id ?? inputs[0]?.id ?? '';
  const layout = pickerLayout(s.guitarEngine);
  const onNative = guitarPath === 'native';
  // A driver holding ≈ 10 ms more on its input: only a replug helps.
  const stuck = onNative && latency !== null && nativeState !== null && driverStuck(nativeState.device, latency, nativeState.buffer, nativeState.sampleRate);
  const why = routeNote(s.guitarEngine, guitarPath, nativeNote && nativeNoteText(nativeNote));
  const clicks = clicksSince(clickBase, xruns);
  if (clicks.baseline !== clickBase) setClickBase(clicks.baseline); // the engine counts from zero again
  const clicksText = onNative ? clicksLine(clicks.clicks, canGrowBuffer(s.nativeBuffer, NATIVE_BUFFERS)) : null;
  const blur = (e: { target: HTMLSelectElement }) => e.target.blur(); // give the arrow keys back to the shortcuts

  const pickNativeDevice = (name: string) => {
    setClickBase(xruns);
    s.setNativeDevice(name === '' ? null : name);
  };
  const pickNativeBuffer = (frames: string) => {
    const buffer = NATIVE_BUFFERS.find((b) => String(b) === frames);
    if (buffer === undefined) return;
    setClickBase(xruns);
    s.setNativeBuffer(buffer);
  };

  return (
    <main className="settings">
      <div className="settings__inner">
        {!s.setupDone && (
          <div className="settings__welcome">
            <div>
              <h1>{i.setupTitle}</h1>
              <p>{i.setupText}</p>
            </div>
            <button type="button" className="btn btn--primary btn--lg" onClick={done}>
              {t.common.done} <kbd>Enter</kbd>
            </button>
          </div>
        )}

        <div className="settings__cols">
          <div className="settings__col">
            <Group title={i.groupAudio}>
              <Row label={i.guitarPath} hint={i.driverHint}>
                <Segmented<GuitarEngine>
                  label={i.guitarPath}
                  value={s.guitarEngine}
                  options={[
                    { value: 'native', label: i.asio },
                    { value: 'browser', label: i.systemAudio },
                  ]}
                  onChange={s.setGuitarEngine}
                />
              </Row>

              {layout.native && (
                <>
                  <Row label={i.soundCard}>
                    <select
                      className="sel"
                      value={s.nativeDevice ?? ''}
                      aria-label={i.soundCard}
                      onChange={(e) => {
                        pickNativeDevice(e.target.value);
                        blur(e);
                      }}
                    >
                      {/* Which card "automatic" took, once the engine has opened one. */}
                      <option value="">{!s.nativeDevice && nativeState?.device ? `${i.automatic}: ${nativeState.device}` : i.automatic}</option>
                      {nativeDeviceNames(nativeState?.devices ?? [], s.nativeDevice).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label={i.buffer} hint={i.bufferHint}>
                    <select
                      className="sel"
                      value={String(s.nativeBuffer)}
                      aria-label={i.buffer}
                      onChange={(e) => {
                        pickNativeBuffer(e.target.value);
                        blur(e);
                      }}
                    >
                      {bufferOptions(NATIVE_BUFFERS).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Row>
                </>
              )}

              {layout.browser && (
                <>
                  <Row label={i.device}>
                    <select
                      className="sel"
                      value={selectedInput}
                      aria-label={i.device}
                      onChange={(e) => {
                        s.setInputDevice(e.target.value);
                        blur(e);
                      }}
                    >
                      <option value={NO_INPUT}>{i.noInput}</option>
                      {inputs.length === 0 && <option value="">{i.defaultInput}</option>}
                      {inputs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </Row>
                  {canPickOutput && outputs.length > 0 && (
                    <Row label={i.output}>
                      <select
                        className="sel"
                        value={s.outputDeviceId ?? 'default'}
                        aria-label={i.output}
                        onChange={(e) => {
                          s.setOutputDevice(e.target.value);
                          blur(e);
                        }}
                      >
                        {outputs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </Row>
                  )}
                  <Row label={i.latencyModeLabel} hint={i.latencyModeHint}>
                    <Segmented<LatencyMode>
                      label={i.latencyModeLabel}
                      value={s.latencyMode}
                      options={[
                        { value: 'fast', label: i.fast },
                        { value: 'safe', label: i.safe },
                      ]}
                      onChange={s.setLatencyMode}
                    />
                  </Row>
                </>
              )}

              <Row label={i.channel} hint={<ChannelNow />}>
                <Segmented<ChannelMode>
                  label={i.channelLabel}
                  value={s.channelMode}
                  options={[
                    { value: 'auto', label: i.channels.auto },
                    { value: 'left', label: i.channels.left },
                    { value: 'right', label: i.channels.right },
                    { value: 'both', label: i.channels.both },
                  ]}
                  onChange={s.setChannelMode}
                />
              </Row>

              <Row
                label={i.latency}
                hint={latency ? (stuck ? i.bufferWontHelp : latencyAdvice(rateLatency(latency.totalMs), guitarPath)) : i.latencyLater}
              >
                {latency && (
                  <span className="readout settings__latency" data-rating={rateLatency(latency.totalMs)} title={latencySource(guitarPath)}>
                    {latencyTotalText(latency, guitarPath)}
                  </span>
                )}
              </Row>

              {(stuck || clicksText || why || (sampleRate !== null && sampleRate !== 48000)) && (
                <div className="set__notes">
                  {stuck && <p className="note note--cold">{textDriverStuck()}</p>}
                  {clicksText && <p className="note note--cold">{clicksText}</p>}
                  {why && <p className="note note--cold">{why}</p>}
                  {sampleRate !== null && sampleRate !== 48000 && <p className="note">{i.sampleRate(fmtMs1(sampleRate / 1000))}</p>}
                </div>
              )}
            </Group>

            <Group title={i.meter}>
              <div className="set__block">
                <LevelMeter size="big" />
                <InputTrim />
              </div>
            </Group>
          </div>

          <div className="settings__col">
            <Group title={i.tuner}>
              <Row label={i.a4Long} hint={i.a4Hint}>
                <span className="stepper">
                  <button type="button" aria-label={i.lower} title={i.lowerTip} onClick={() => s.setA4(s.a4 - 1)}>
                    <Minus size={14} />
                  </button>
                  <span className="stepper__value">
                    {s.a4} {t.common.units.hz}
                  </span>
                  <button type="button" aria-label={i.higher} title={i.higherTip} onClick={() => s.setA4(s.a4 + 1)}>
                    <Plus size={14} />
                  </button>
                </span>
              </Row>
              <Row label={i.tuner}>
                <button type="button" className="btn" title={withKey(i.bigTuner, 'T')} onClick={() => patch({ bigTuner: true })}>
                  <IconTuner size={16} />
                  {i.bigTuner}
                </button>
              </Row>
            </Group>

            <Group title={i.groupInterface}>
              <Row label={i.language}>
                <select
                  className="sel"
                  value={s.language}
                  aria-label="Language"
                  onChange={(e) => {
                    s.setLang(e.target.value as Lang);
                    blur(e);
                  }}
                >
                  {LANGS.map((lang) => (
                    <option key={lang} value={lang}>
                      {LANG_NAMES[lang]}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t.keys.title}>
                <button type="button" className="btn" title={withKey(t.keys.title, 'F1')} onClick={() => patch({ keysOpen: true })}>
                  {i.showKeys}
                </button>
              </Row>
            </Group>

            <Group title={i.groupRecording}>
              <Toggle label={i.saveRawInput} on={s.saveRawInput} hint={i.saveRawInputHint} onChange={s.setSaveRawInput} />
              <p className="row__hint set__hint">{i.saveRawInputHint}</p>
            </Group>

            <Group title={i.groupAbout}>
              <Row label={APP_NAME} hint={t.shell.about.version(__STRUM_VERSION__)}>
                <button type="button" className="btn" onClick={() => patch({ aboutOpen: true })}>
                  {i.licenses}
                </button>
              </Row>
            </Group>
          </div>
        </div>
      </div>
    </main>
  );
}
