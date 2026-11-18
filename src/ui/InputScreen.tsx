import type { Lang } from '../i18n';
import { LANG_LABEL, LANG_NAMES } from '../i18n/lang';
import { NO_INPUT } from '../audio/input';
import { nativeNoteText, textDriverStuck } from '../audio/native/session';
import { driverStuck, rateLatency } from '../dsp/latency';
import type { ChannelMode } from '../dsp/channel';
import { APP_NAME, withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { useRuntime } from '../state/runtime';
import { NATIVE_BUFFERS, useSettings, type GuitarEngine, type LatencyMode } from '../state/settings';
import { Toggle, Segmented, Select } from './controls';
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
  nativeLatencyLine,
  pickerLayout,
  routeNote,
} from './guitarInput';
import { InputTrim } from './InputTrim';
import { LevelMeter } from './LevelMeter';
import { Tuner } from './Tuner';
import { useEngineFrame } from './useEngineFrame';
import { useEffect, useRef, useState } from 'react';

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
  return <span ref={el} className="input__channel-now" />;
}

export function InputScreen() {
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
  // The engine's dropout count when the card or the buffer was last changed here.
  const [clickBase, setClickBase] = useState(0);

  const done = () => {
    s.markSetupDone();
    patch({ view: 'song' });
  };

  const selectedInput =
    s.inputDeviceId ?? inputs.find((d) => d.label === activeLabel)?.id ?? inputs[0]?.id ?? '';

  const layout = pickerLayout(s.guitarEngine);
  const onNative = guitarPath === 'native';
  // The M-Track driver holding ≈ 10 ms more on its input: only a replug helps (2026-11-13).
  const stuck = onNative && latency !== null && nativeState !== null && driverStuck(nativeState.device, latency, nativeState.buffer, nativeState.sampleRate);
  const why = routeNote(s.guitarEngine, guitarPath, nativeNote && nativeNoteText(nativeNote));
  const clicks = clicksSince(clickBase, xruns);
  if (clicks.baseline !== clickBase) setClickBase(clicks.baseline); // the engine counts from zero again
  const clicksText = onNative ? clicksLine(clicks.clicks, canGrowBuffer(s.nativeBuffer, NATIVE_BUFFERS)) : null;

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
    <main className="input">
      <header className="input__head">
        <h1>{t.input.title}</h1>
        <div className="input__lang">
          <button type="button" className="link" onClick={() => patch({ aboutOpen: true })}>
            {t.shell.about.open(APP_NAME)}
          </button>
          <Segmented<Lang>
            label={LANG_LABEL}
            value={s.language}
            options={[
              { value: 'en', label: LANG_NAMES.en },
              { value: 'ru', label: LANG_NAMES.ru },
            ]}
            onChange={s.setLang}
          />
        </div>
        <button type="button" className="btn btn--primary btn--big" onClick={done}>
          {t.common.done} <kbd>Enter</kbd>
        </button>
      </header>

      <div className="input__grid">
        <section className="surface input__col">
          <h2>{t.input.source}</h2>
          <div className="field">
            <span className="field__label">{t.input.guitarPath}</span>
            <Segmented<GuitarEngine>
              label={t.input.guitarPath}
              value={s.guitarEngine}
              options={[
                { value: 'native', label: t.input.asio },
                { value: 'browser', label: t.input.systemAudio },
              ]}
              onChange={s.setGuitarEngine}
            />
          </div>

          {layout.native && (
            <>
              <Select label={t.input.soundCard} value={s.nativeDevice ?? ''} onChange={pickNativeDevice}>
                {/* Which card "automatic" took, once the engine has opened one. */}
                <option value="">
                  {!s.nativeDevice && nativeState?.device ? `${t.input.automatic}: ${nativeState.device}` : t.input.automatic}
                </option>
                {nativeDeviceNames(nativeState?.devices ?? [], s.nativeDevice).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select label={t.input.buffer} value={String(s.nativeBuffer)} onChange={pickNativeBuffer}>
                {bufferOptions(NATIVE_BUFFERS).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {onNative && latency && <p className="input__line">{nativeLatencyLine(latency)}</p>}
              {stuck && <p className="input__line input__line--cold">{textDriverStuck()}</p>}
              {clicksText && <p className="input__line input__line--cold">{clicksText}</p>}
              {why && <p className="input__line input__line--cold">{why}</p>}
            </>
          )}

          {layout.browser && (
            <Select label={t.input.device} value={selectedInput} onChange={(id) => s.setInputDevice(id)}>
              <option value={NO_INPUT}>{t.input.noInput}</option>
              {inputs.length === 0 && <option value="">{t.input.defaultInput}</option>}
              {inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          )}

          <div className="field">
            <span className="field__label">
              {t.input.channel} <ChannelNow />
            </span>
            <Segmented<ChannelMode>
              label={t.input.channelLabel}
              value={s.channelMode}
              options={[
                { value: 'auto', label: t.input.channels.auto },
                { value: 'left', label: t.input.channels.left },
                { value: 'right', label: t.input.channels.right },
                { value: 'both', label: t.input.channels.both },
              ]}
              onChange={s.setChannelMode}
            />
          </div>

          <div className="field">
            <span className="field__label">{t.input.level}</span>
            <LevelMeter size="big" />
          </div>
          <InputTrim />
          <Toggle label={t.input.saveRawInput} on={s.saveRawInput} hint={t.input.saveRawInputHint} onChange={s.setSaveRawInput} />
        </section>

        <section className="surface input__col input__col--tuner">
          <h2>{t.input.tuner}</h2>
          <Tuner size="big" />
          <div className="calib">
            <span className="calib__label">
              {t.input.a4}{' '}
              <b className="num">
                {s.a4} {t.common.units.hz}
              </b>
            </span>
            <button type="button" className="btn calib__btn" onClick={() => s.setA4(s.a4 - 1)} aria-label={t.input.lower} title={t.input.lowerTip}>
              −
            </button>
            <button type="button" className="btn calib__btn" onClick={() => s.setA4(s.a4 + 1)} aria-label={t.input.higher} title={t.input.higherTip}>
              +
            </button>
          </div>
          <p className="caption input__bigtuner">
            <button type="button" className="link" title={withKey(t.input.bigTuner, 'T')} onClick={() => patch({ bigTuner: true })}>
              {t.input.bigTuner}
            </button>
          </p>
        </section>

        <section className="surface input__col">
          <h2>{t.input.latency}</h2>
          {latency ? (
            <div className="lat" data-rating={rateLatency(latency.totalMs)}>
              <span className="lat__total num">{latencyTotalText(latency, guitarPath)}</span>
              {!onNative && (
                <span className="lat__parts num">
                  {t.input.latencyParts(
                    Math.round(latency.inputMs),
                    latency.inputEstimated,
                    Math.round(latency.processingMs),
                    Math.round(latency.outputMs),
                  )}
                </span>
              )}
              <p className="lat__text">
                {stuck ? t.input.bufferWontHelp : latencyAdvice(rateLatency(latency.totalMs), guitarPath)}
              </p>
            </div>
          ) : (
            <p className="lat__text">{t.input.latencyLater}</p>
          )}
          {layout.browser && (
            <div className="lat__controls">
              <div className="field">
                <span className="field__label">{t.input.latencyMode}</span>
                <Segmented<LatencyMode>
                  label={t.input.latencyModeLabel}
                  value={s.latencyMode}
                  options={[
                    { value: 'fast', label: t.input.fast },
                    { value: 'safe', label: t.input.safe },
                  ]}
                  onChange={s.setLatencyMode}
                />
              </div>
              {canPickOutput && outputs.length > 0 && (
                <Select label={t.input.output} value={s.outputDeviceId ?? 'default'} onChange={(id) => s.setOutputDevice(id)}>
                  {outputs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}
          <div className="input__notes">
            {sampleRate !== null && sampleRate !== 48000 && (
              <p className="note">{t.input.sampleRate(fmtMs1(sampleRate / 1000))}</p>
            )}
            <p className="note">{latencySource(guitarPath)}</p>
          </div>
        </section>
      </div>
    </main>
  );
}
