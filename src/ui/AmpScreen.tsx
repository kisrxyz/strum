import { BUILTIN_IRS, BUILTIN_MODELS, builtinName, listUserAssets, modelDefaults, removeUserAsset, SIMPLE_AMP } from '../audio/assets';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { DEFAULT_PRESETS, type PresetPatch, type ReverbType } from '../state/presets';
import { useRuntime } from '../state/runtime';
import { currentPreset, MASTER_MAX_DB, MASTER_MIN_DB, useSettings, type MainsSetting } from '../state/settings';
import { Segmented, Select, Toggle, fmtDb, fmtHz, fmtMs, fmtPct } from './controls';
import { Knob } from './Knob';
import { PresetTiles } from './PresetTiles';

export function AmpScreen() {
  const preset = useSettings(currentPreset);
  const index = useSettings((s) => s.presetIndex);
  const update = useSettings((s) => s.updatePreset);
  const reset = useSettings((s) => s.resetPreset);
  const forgetAsset = useSettings((s) => s.forgetAsset);
  const masterDb = useSettings((s) => s.masterDb);
  const setMasterDb = useSettings((s) => s.setMasterDb);
  const mains = useSettings((s) => s.mains);
  const mainsHz = useSettings((s) => s.mainsHz);
  const setMains = useSettings((s) => s.setMains);
  const amp = useRuntime((s) => s.amp);
  const userAssets = useRuntime((s) => s.userAssets);
  const patchRuntime = useRuntime((s) => s.patch);
  const showToast = useRuntime((s) => s.showToast);
  const t = useLang();
  const a = t.amp;

  const set = (patch: PresetPatch) => update(index, patch);
  const userModels = userAssets.filter((a) => a.kind === 'model');
  const userIrs = userAssets.filter((a) => a.kind === 'ir');
  const isNam = preset.amp.model !== SIMPLE_AMP;
  // Only A2 captures have a smaller sub-model; a user's file may be one.
  const slimmable = BUILTIN_MODELS.find((m) => m.id === preset.amp.model)?.slimmable ?? preset.amp.model.startsWith('user:');

  const removeOwn = async (id: string) => {
    await removeUserAsset(id);
    patchRuntime({ userAssets: await listUserAssets() });
    forgetAsset(id);
    showToast(a.ownDeleted);
  };

  const model = preset.amp.model;
  // Double-click on a knob: the preset's own value; drive and level follow an amp chosen by hand.
  const def = DEFAULT_PRESETS[index] ?? DEFAULT_PRESETS[0];
  const ownAmp = model === def.amp.model ? null : modelDefaults(model);
  const defDrive = ownAmp?.inputDb ?? (model === def.amp.model ? def.amp.inputDb : 0);
  const defLevel = ownAmp?.levelDb ?? (model === def.amp.model ? def.amp.levelDb : 0);
  const status =
    amp.state === 'loading'
      ? a.loading
      : amp.state === 'fallback'
        ? amp.message
        : model.startsWith('user:')
          ? a.ownModel
          : Object.hasOwn(a.modelNotes, model)
            ? a.modelNotes[model as keyof typeof a.modelNotes]
            : undefined;

  return (
    <main className="amp">
      <header className="amp__head">
        <h1>{t.shell.screens.amp}</h1>
      </header>

      <PresetTiles />

      <section className="surface amp__main" aria-label={a.section}>
        <div className="amp__sources">
          {/* A built-in amp comes with its own drive and level: as captured they differ by 15 dB and more. */}
          <Select label={a.amp} value={preset.amp.model} onChange={(model) => set({ amp: { model, ...modelDefaults(model) } })}>
            <optgroup label={a.builtIn}>
              {BUILTIN_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {builtinName(m)}
                </option>
              ))}
            </optgroup>
            {userModels.length > 0 && (
              <optgroup label={a.own}>
                {userModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          <Select label={a.cabinet} value={preset.cab} onChange={(cab) => set({ cab })}>
            <optgroup label={a.builtIn}>
              {BUILTIN_IRS.map((c) => (
                <option key={c.id} value={c.id}>
                  {builtinName(c)}
                </option>
              ))}
            </optgroup>
            {userIrs.length > 0 && (
              <optgroup label={a.own}>
                {userIrs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          <div className="amp__about">
            <p className={`amp__status amp__status--${amp.state}`}>{status}</p>
            <p className="caption" title={a.ownSoundTip}>
              {a.ownSound.before} <b>.nam</b> {a.ownSound.or} <b>.wav</b>
              {a.ownSound.after && ` ${a.ownSound.after}`}
            </p>
          </div>
          <div className="amp__actions">
            <div className="amp__hum">
              <Toggle label={a.hum} on={preset.amp.hum} hint={a.humHint} onChange={(hum) => set({ amp: { hum } })} />
              <div className={`amp__mains${preset.amp.hum ? '' : ' amp__mains--off'}`} title={a.mainsHint}>
                <Segmented<'auto' | '50' | '60'>
                  label={a.mains}
                  value={String(mains) as 'auto' | '50' | '60'}
                  options={[
                    { value: 'auto', label: a.mainsAuto(mainsHz) },
                    { value: '50', label: `50 ${t.common.units.hz}` },
                    { value: '60', label: `60 ${t.common.units.hz}` },
                  ]}
                  onChange={(v) => setMains(v === 'auto' ? 'auto' : (Number(v) as MainsSetting))}
                />
              </div>
            </div>
            <Toggle label={a.gateAuto} on={preset.amp.gateAuto} hint={a.gateAutoHint} onChange={(gateAuto) => set({ amp: { gateAuto } })} />
            {isNam && slimmable && (
              <Toggle label={a.slim} on={preset.amp.slim} hint={a.slimHint} onChange={(slim) => set({ amp: { slim } })} />
            )}
            <span className="amp__links">
              {preset.amp.model.startsWith('user:') && (
                <button type="button" className="link" onClick={() => removeOwn(preset.amp.model)}>
                  {a.deleteOwnModel}
                </button>
              )}
              {preset.cab.startsWith('user:') && (
                <button type="button" className="link" onClick={() => removeOwn(preset.cab)}>
                  {a.deleteOwnCabinet}
                </button>
              )}
              <button type="button" className="link" onClick={() => reset(index)}>
                {a.resetPreset}
              </button>
            </span>
          </div>
        </div>

        <div className="amp__knobs">
          <Knob label={a.drive} value={preset.amp.inputDb} min={-24} max={12} step={0.5} defaultValue={defDrive}
            format={fmtDb} onChange={(inputDb) => set({ amp: { inputDb } })} />
          <Knob label={a.gate} value={preset.amp.gateDb} min={-90} max={-30} step={1} defaultValue={def.amp.gateDb}
            format={(v) => (v <= -90 ? t.common.off : fmtDb(v))} onChange={(gateDb) => set({ amp: { gateDb } })} />
          <Knob label={a.bass} value={preset.amp.bass} min={-6} max={6} step={0.5} defaultValue={def.amp.bass} bipolar
            format={fmtDb} onChange={(bass) => set({ amp: { bass } })} />
          <Knob label={a.middle} value={preset.amp.mid} min={-6} max={6} step={0.5} defaultValue={def.amp.mid} bipolar
            format={fmtDb} onChange={(mid) => set({ amp: { mid } })} />
          <Knob label={a.treble} value={preset.amp.treble} min={-6} max={6} step={0.5} defaultValue={def.amp.treble} bipolar
            format={fmtDb} onChange={(treble) => set({ amp: { treble } })} />
          <Knob label={a.level} value={preset.amp.levelDb} min={-12} max={12} step={0.5} defaultValue={defLevel} bipolar
            format={fmtDb} onChange={(levelDb) => set({ amp: { levelDb } })} />
          <div className="amp__master">
            <Knob label={a.master} value={masterDb} min={MASTER_MIN_DB} max={MASTER_MAX_DB} step={1} defaultValue={0}
              hint={`${withKey(a.masterTip, '↑ / ↓')} · ${withKey(a.muteGuitar, 'M')}`} format={fmtDb} onChange={setMasterDb} />
          </div>
        </div>
      </section>

      <div className="effects">
        <section className={`surface effect${preset.chorus.on ? ' effect--on' : ''}`} aria-label={a.chorus}>
          <Toggle label={a.chorus} on={preset.chorus.on} onChange={(on) => set({ chorus: { on } })} />
          <div className="effect__knobs">
            <Knob size="small" label={a.rate} value={preset.chorus.rate} min={0.1} max={3} step={0.05} defaultValue={def.chorus.rate}
              format={fmtHz} disabled={!preset.chorus.on} onChange={(rate) => set({ chorus: { rate } })} />
            <Knob size="small" label={a.depth} value={preset.chorus.depth} min={0} max={1} step={0.01} defaultValue={def.chorus.depth}
              format={fmtPct} disabled={!preset.chorus.on} onChange={(depth) => set({ chorus: { depth } })} />
            <Knob size="small" label={a.mix} value={preset.chorus.mix} min={0} max={1} step={0.01} defaultValue={def.chorus.mix}
              format={fmtPct} disabled={!preset.chorus.on} onChange={(mix) => set({ chorus: { mix } })} />
          </div>
        </section>
        <section className={`surface effect${preset.delay.on ? ' effect--on' : ''}`} aria-label={a.delay}>
          <Toggle label={a.delay} on={preset.delay.on} onChange={(on) => set({ delay: { on } })} />
          <div className="effect__knobs">
            <Knob size="small" label={a.time} value={preset.delay.timeMs} min={60} max={1000} step={5} defaultValue={def.delay.timeMs}
              format={fmtMs} disabled={!preset.delay.on} onChange={(timeMs) => set({ delay: { timeMs } })} />
            <Knob size="small" label={a.feedback} value={preset.delay.feedback} min={0} max={0.85} step={0.01} defaultValue={def.delay.feedback}
              format={fmtPct} disabled={!preset.delay.on} onChange={(feedback) => set({ delay: { feedback } })} />
            <Knob size="small" label={a.mix} value={preset.delay.mix} min={0} max={0.6} step={0.01} defaultValue={def.delay.mix}
              format={fmtPct} disabled={!preset.delay.on} onChange={(mix) => set({ delay: { mix } })} />
          </div>
        </section>
        <section className={`surface effect${preset.reverb.on ? ' effect--on' : ''}`} aria-label={a.reverb}>
          <Toggle label={a.reverb} on={preset.reverb.on} onChange={(on) => set({ reverb: { on } })} />
          <div className="effect__knobs">
            <div className={`effect__type${preset.reverb.on ? '' : ' effect__type--off'}`}>
              <Segmented<ReverbType>
                label={a.reverbType}
                value={preset.reverb.type}
                options={[
                  { value: 'spring', label: a.spring },
                  { value: 'plate', label: a.plate },
                ]}
                onChange={(type) => set({ reverb: { type } })}
              />
            </div>
            <Knob size="small" label={a.mix} value={preset.reverb.mix} min={0} max={0.6} step={0.01} defaultValue={def.reverb.mix}
              format={fmtPct} disabled={!preset.reverb.on} onChange={(mix) => set({ reverb: { mix } })} />
          </div>
        </section>
      </div>
    </main>
  );
}
