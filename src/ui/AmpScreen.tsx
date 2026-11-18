import { FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { addAmpFiles } from '../app/ampFiles';
import { BUILTIN_IRS, BUILTIN_MODELS, builtinName, listUserAssets, modelDefaults, NO_CAB, removeUserAsset, SIMPLE_AMP } from '../audio/assets';
import { withKey } from '../i18n';
import { useLang } from '../i18n/useLang';
import { DEFAULT_PRESETS, type PresetPatch, type ReverbType } from '../state/presets';
import { useRuntime } from '../state/runtime';
import { currentPreset, MASTER_MAX_DB, MASTER_MIN_DB, useSettings, type MainsSetting } from '../state/settings';
import { fmtDb, fmtHz, fmtMs, fmtPct } from './controls';
import { Knob } from './Knob';
import { PresetList } from './PresetTiles';

/** How a head is dressed, by the family of the amp it stands for: its panel and its knobs. */
type Skin = 'black' | 'gold' | 'oxblood' | 'steel' | 'silver' | 'plain';

const SKINS: Record<string, Skin> = {
  'nam:twin': 'black',
  'nam:deluxe-a2': 'black',
  'nam:jc': 'black',
  'nam:jcm2000': 'gold',
  'nam:jcm900': 'gold',
  'nam:jcm': 'gold',
  'nam:shirley': 'gold',
  'nam:ac15': 'oxblood',
  'nam:ac10': 'oxblood',
  'nam:5150': 'steel',
  'nam:5153': 'steel',
  'nam:dumble': 'silver',
};

/** A small lever switch, as on an amp's panel: up is on. */
function Lever({ label, on, hint, onChange }: { label: string; on: boolean; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" className={`lever${on ? ' lever--on' : ''}`} aria-checked={on} title={hint} onClick={() => onChange(!on)}>
      <span className="lever__slot" aria-hidden="true">
        <i />
      </span>
      <span className="lever__label">{label}</span>
    </button>
  );
}

/** A stompbox: its knobs on top, its name, and the footswitch with a light that turns it on. */
function Pedal({ kind, name, on, onToggle, children }: { kind: string; name: string; on: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`pedal pedal--${kind}${on ? ' pedal--on' : ''}`} aria-label={name}>
      <div className="pedal__knobs">{children}</div>
      <span className="pedal__name">{name}</span>
      <button type="button" role="switch" className="pedal__switch" aria-checked={on} aria-label={name} onClick={onToggle}>
        <i className="pedal__led" aria-hidden="true" />
        <span className="pedal__foot" aria-hidden="true" />
      </button>
    </section>
  );
}

/**
 * The amp: the presets on the left; in the middle the head (its model on the top strip; on the
 * panel the input section with the gate and the hum filter, then gain, tone, level and the master),
 * and under it the cabinet and the pedals (chorus, delay, reverb). A head is dressed by the family
 * of its amp. Your own .nam or .wav: the folder button, or dropped into the window.
 */
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
  const running = useRuntime((s) => s.status === 'running');
  const userAssets = useRuntime((s) => s.userAssets);
  const patchRuntime = useRuntime((s) => s.patch);
  const showToast = useRuntime((s) => s.showToast);
  const picker = useRef<HTMLInputElement>(null);
  const t = useLang();
  const a = t.amp;

  const set = (patch: PresetPatch) => update(index, patch);
  const userModels = userAssets.filter((a) => a.kind === 'model');
  const userIrs = userAssets.filter((a) => a.kind === 'ir');
  const model = preset.amp.model;
  const isNam = model !== SIMPLE_AMP;
  // Only A2 captures have a smaller sub-model; a user's file may be one.
  const slimmable = BUILTIN_MODELS.find((m) => m.id === model)?.slimmable ?? model.startsWith('user:');
  const skin: Skin = SKINS[model] ?? 'plain';

  const removeOwn = async (id: string) => {
    await removeUserAsset(id);
    patchRuntime({ userAssets: await listUserAssets() });
    forgetAsset(id);
    showToast(a.ownDeleted);
  };

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
      <aside className="amp__side">
        <div className="panel-head">
          <span className="panel-head__title">{a.presetsLabel}</span>
          <button type="button" className="iconbtn iconbtn--sm" aria-label={a.resetPreset} title={a.resetPreset} onClick={() => reset(index)}>
            <RotateCcw size={14} />
          </button>
        </div>
        <PresetList />
      </aside>

      <div className="amp__rig">
        <div className="rig">
          <section className={`head head--${skin}`} aria-label={a.section}>
            <div className="head__top">
              <select
                className="head__model"
                aria-label={a.amp}
                value={model}
                onChange={(e) => {
                  // A built-in amp comes with its own drive and level: as captured they differ by 15 dB and more.
                  set({ amp: { model: e.target.value, ...modelDefaults(e.target.value) } });
                  e.target.blur(); // give the arrow keys back to the shortcuts
                }}
              >
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
              </select>
              <span className={`head__note head__note--${amp.state}`}>{status}</span>
              <span className="head__gap" />
              {isNam && slimmable && (
                <button type="button" className="btn btn--sm btn--ghost" aria-pressed={preset.amp.slim} title={a.slimHint} onClick={() => set({ amp: { slim: !preset.amp.slim } })}>
                  {a.slim}
                </button>
              )}
              {model.startsWith('user:') && (
                <button type="button" className="iconbtn" aria-label={a.deleteOwnModel} title={a.deleteOwnModel} onClick={() => removeOwn(model)}>
                  <Trash2 size={16} />
                </button>
              )}
              <button type="button" className="btn btn--sm btn--ghost" title={a.ownSoundTip} onClick={() => picker.current?.click()}>
                <FolderOpen size={14} />
                {a.ownFile}
              </button>
              <input
                ref={picker}
                type="file"
                hidden
                accept=".nam,.wav"
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) void addAmpFiles(files);
                }}
              />
            </div>

            <div className="head__plate">
              <div className="head__zone head__zone--input">
                <Knob label={a.gate} value={preset.amp.gateDb} min={-90} max={-30} step={1} defaultValue={def.amp.gateDb}
                  format={(v) => (v <= -90 ? t.common.off : fmtDb(v))} onChange={(gateDb) => set({ amp: { gateDb } })} />
                <div className="head__levers">
                  <Lever label={a.gateAutoShort} on={preset.amp.gateAuto} hint={`${a.gateAuto}. ${a.gateAutoHint}`} onChange={(gateAuto) => set({ amp: { gateAuto } })} />
                  <Lever label={a.humShort} on={preset.amp.hum} hint={`${a.hum}. ${a.humHint}`} onChange={(hum) => set({ amp: { hum } })} />
                </div>
              </div>

              <div className="head__zone head__zone--tone">
                <Knob label={a.drive} value={preset.amp.inputDb} min={-24} max={12} step={0.5} defaultValue={defDrive}
                  format={fmtDb} onChange={(inputDb) => set({ amp: { inputDb } })} />
                <Knob label={a.bass} value={preset.amp.bass} min={-6} max={6} step={0.5} defaultValue={def.amp.bass} bipolar
                  format={fmtDb} onChange={(bass) => set({ amp: { bass } })} />
                <Knob label={a.middle} value={preset.amp.mid} min={-6} max={6} step={0.5} defaultValue={def.amp.mid} bipolar
                  format={fmtDb} onChange={(mid) => set({ amp: { mid } })} />
                <Knob label={a.treble} value={preset.amp.treble} min={-6} max={6} step={0.5} defaultValue={def.amp.treble} bipolar
                  format={fmtDb} onChange={(treble) => set({ amp: { treble } })} />
                <Knob label={a.level} value={preset.amp.levelDb} min={-12} max={12} step={0.5} defaultValue={defLevel} bipolar
                  format={fmtDb} onChange={(levelDb) => set({ amp: { levelDb } })} />
              </div>

              <div className="head__zone head__zone--master">
                <Knob label={a.master} value={masterDb} min={MASTER_MIN_DB} max={MASTER_MAX_DB} step={1} defaultValue={0}
                  hint={`${withKey(a.masterTip, '↑ / ↓')} · ${withKey(a.muteGuitar, 'M')}`} format={fmtDb} onChange={setMasterDb} />
                <i className="head__lamp" data-on={running && amp.state !== 'loading'} aria-hidden="true" />
              </div>
            </div>
          </section>

          <div className="rig__row">
            <section className="cab" aria-label={a.cabinet}>
              <div className={`cab__grille${preset.cab === NO_CAB ? ' cab__grille--none' : ''}`} aria-hidden="true" />
              <div className="cab__plate">
                <span className="cab__label">{a.cabinet}</span>
                <select
                  className="sel cab__select"
                  aria-label={a.cabinet}
                  value={preset.cab}
                  onChange={(e) => {
                    set({ cab: e.target.value });
                    e.target.blur();
                  }}
                >
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
                </select>
                {preset.cab.startsWith('user:') && (
                  <button type="button" className="iconbtn" aria-label={a.deleteOwnCabinet} title={a.deleteOwnCabinet} onClick={() => removeOwn(preset.cab)}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {preset.amp.hum && (
                <label className="cab__mains" title={a.mainsHint}>
                  <span className="cab__label">{a.hum}</span>
                  <select
                    className="sel"
                    value={String(mains)}
                    aria-label={a.mains}
                    onChange={(e) => {
                      setMains(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as MainsSetting));
                      e.target.blur();
                    }}
                  >
                    <option value="auto">{a.mainsAuto(mainsHz)}</option>
                    <option value="50">50 {t.common.units.hz}</option>
                    <option value="60">60 {t.common.units.hz}</option>
                  </select>
                </label>
              )}
            </section>

            <Pedal kind="chorus" name={a.chorus} on={preset.chorus.on} onToggle={() => set({ chorus: { on: !preset.chorus.on } })}>
              <Knob size="small" label={a.rate} value={preset.chorus.rate} min={0.1} max={3} step={0.05} defaultValue={def.chorus.rate}
                format={fmtHz} disabled={!preset.chorus.on} onChange={(rate) => set({ chorus: { rate } })} />
              <Knob size="small" label={a.depth} value={preset.chorus.depth} min={0} max={1} step={0.01} defaultValue={def.chorus.depth}
                format={fmtPct} disabled={!preset.chorus.on} onChange={(depth) => set({ chorus: { depth } })} />
              <Knob size="small" label={a.mix} value={preset.chorus.mix} min={0} max={1} step={0.01} defaultValue={def.chorus.mix}
                format={fmtPct} disabled={!preset.chorus.on} onChange={(mix) => set({ chorus: { mix } })} />
            </Pedal>

            <Pedal kind="delay" name={a.delay} on={preset.delay.on} onToggle={() => set({ delay: { on: !preset.delay.on } })}>
              <Knob size="small" label={a.time} value={preset.delay.timeMs} min={60} max={1000} step={5} defaultValue={def.delay.timeMs}
                format={fmtMs} disabled={!preset.delay.on} onChange={(timeMs) => set({ delay: { timeMs } })} />
              <Knob size="small" label={a.feedback} value={preset.delay.feedback} min={0} max={0.85} step={0.01} defaultValue={def.delay.feedback}
                format={fmtPct} disabled={!preset.delay.on} onChange={(feedback) => set({ delay: { feedback } })} />
              <Knob size="small" label={a.mix} value={preset.delay.mix} min={0} max={0.6} step={0.01} defaultValue={def.delay.mix}
                format={fmtPct} disabled={!preset.delay.on} onChange={(mix) => set({ delay: { mix } })} />
            </Pedal>

            <Pedal kind="reverb" name={a.reverb} on={preset.reverb.on} onToggle={() => set({ reverb: { on: !preset.reverb.on } })}>
              <Knob size="small" label={a.mix} value={preset.reverb.mix} min={0} max={0.6} step={0.01} defaultValue={def.reverb.mix}
                format={fmtPct} disabled={!preset.reverb.on} onChange={(mix) => set({ reverb: { mix } })} />
              <div className="pedal__type" role="radiogroup" aria-label={a.reverbType}>
                {(['spring', 'plate'] as ReverbType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={preset.reverb.type === type}
                    disabled={!preset.reverb.on}
                    onClick={() => set({ reverb: { type } })}
                  >
                    {a[type]}
                  </button>
                ))}
              </div>
            </Pedal>
          </div>
        </div>
      </div>
    </main>
  );
}
