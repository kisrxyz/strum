// Amp presets: the four from the spec, plus helpers to edit them.

export type ReverbType = 'spring' | 'plate';

export interface AmpSettings {
  /** 'nam:<file>' built-in model, 'user:<id>' dropped model, or 'simple' (no NAM). */
  model: string;
  /** Drive into the amp, dB. */
  inputDb: number;
  /** Noise gate threshold, dBFS (−90 and lower: the gate is off). */
  gateDb: number;
  /** «Шумодав сам»: the gate finds the input's noise itself and never opens lower than a little over it. */
  gateAuto: boolean;
  bass: number;
  mid: number;
  treble: number;
  /** Preset output level, dB. */
  levelDb: number;
  /** Use the smaller sub-model of an A2 capture (less CPU). */
  slim: boolean;
  /** «Фильтр гула»: narrow notches at 50 Hz and its harmonics before the gate (no latency). */
  hum: boolean;
}

export interface ChorusSettings {
  on: boolean;
  /** LFO rate, Hz. */
  rate: number;
  /** 0..1 */
  depth: number;
  /** 0..1 */
  mix: number;
}

export interface DelaySettings {
  on: boolean;
  timeMs: number;
  /** 0..0.9 */
  feedback: number;
  /** 0..1 */
  mix: number;
}

export interface ReverbSettings {
  on: boolean;
  type: ReverbType;
  /** 0..1 */
  mix: number;
}

export interface Preset {
  id: string;
  name: string;
  amp: AmpSettings;
  /** 'ir:<file>' built-in cabinet, 'user:<id>' dropped IR, or 'none'. */
  cab: string;
  chorus: ChorusSettings;
  delay: DelaySettings;
  reverb: ReverbSettings;
}

export interface PresetPatch {
  name?: string;
  cab?: string;
  amp?: Partial<AmpSettings>;
  chorus?: Partial<ChorusSettings>;
  delay?: Partial<DelaySettings>;
  reverb?: Partial<ReverbSettings>;
}

const CHORUS_OFF: ChorusSettings = { on: false, rate: 0.8, depth: 0.5, mix: 0.5 };
const DELAY_OFF: DelaySettings = { on: false, timeMs: 380, feedback: 0.3, mix: 0.2 };

// The effects are drier than the first presets' (2026-11-16, the author: «не чисто, а размыто»):
// less chorus on the clean one, less reverb everywhere, a shorter echo on the solo.
// The amps are captures of real amps (2026-11-16: the author did not like the first ones). Drive and level are
// set so that each preset is exactly as loud as before on the TONE3000 DI «Brit - Guitar» at −9 dBFS
// peak (measured through the fast engine's chain): the Twin stays clean even pushed +9 dB, the
// JCM2000 at −15 dB is a light crunch like the Dumble was at −12, the JCM900 and the Dirty Shirley
// are the drive and the singing lead.
export const DEFAULT_PRESETS: readonly Preset[] = [
  {
    id: 'clean-chorus',
    name: 'Clean chorus',
    amp: { model: 'nam:twin', inputDb: 9, gateDb: -70, gateAuto: true, bass: 0, mid: 0, treble: 1, levelDb: 11.5, slim: false, hum: true },
    cab: 'ir:celestion',
    chorus: { on: true, rate: 0.8, depth: 0.45, mix: 0.35 },
    delay: DELAY_OFF,
    reverb: { on: true, type: 'spring', mix: 0.15 },
  },
  {
    id: 'crunch',
    name: 'Crunch',
    amp: { model: 'nam:jcm2000', inputDb: -15, gateDb: -64, gateAuto: true, bass: 0, mid: 1, treble: 0, levelDb: 1, slim: false, hum: true },
    cab: 'ir:celestion',
    chorus: CHORUS_OFF,
    delay: DELAY_OFF,
    reverb: { on: true, type: 'spring', mix: 0.08 },
  },
  {
    id: 'drive',
    name: 'Drive',
    amp: { model: 'nam:jcm900', inputDb: 0, gateDb: -58, gateAuto: true, bass: 1, mid: 0, treble: 0, levelDb: 0.5, slim: false, hum: true },
    cab: 'ir:mesa',
    chorus: CHORUS_OFF,
    delay: DELAY_OFF,
    reverb: { on: true, type: 'plate', mix: 0.07 },
  },
  {
    id: 'solo',
    name: 'Lead',
    amp: { model: 'nam:shirley', inputDb: -12, gateDb: -60, gateAuto: true, bass: 0, mid: 2, treble: 0, levelDb: -7.5, slim: false, hum: true },
    cab: 'ir:celestion',
    chorus: CHORUS_OFF,
    delay: { on: true, timeMs: 380, feedback: 0.28, mix: 0.18 },
    reverb: { on: true, type: 'plate', mix: 0.12 },
  },
];

/** The first presets' amps (until 2026-11-16): model, drive and level by preset id. */
export const FIRST_AMPS: Readonly<Record<string, Pick<AmpSettings, 'model' | 'inputDb' | 'levelDb'>>> = {
  'clean-chorus': { model: 'nam:jc', inputDb: 0, levelDb: 5.5 },
  crunch: { model: 'nam:dumble', inputDb: -12, levelDb: 6 },
  drive: { model: 'nam:jcm', inputDb: 0, levelDb: -0.5 },
  solo: { model: 'nam:dumble', inputDb: 2, levelDb: -0.5 },
};

/** The first presets' effects (until 2026-11-16), by preset id. */
export const FIRST_EFFECTS: Readonly<Record<string, Pick<Preset, 'chorus' | 'delay' | 'reverb'>>> = {
  'clean-chorus': { chorus: { on: true, rate: 0.8, depth: 0.55, mix: 0.5 }, delay: DELAY_OFF, reverb: { on: true, type: 'spring', mix: 0.22 } },
  crunch: { chorus: CHORUS_OFF, delay: DELAY_OFF, reverb: { on: true, type: 'spring', mix: 0.12 } },
  drive: { chorus: CHORUS_OFF, delay: DELAY_OFF, reverb: { on: true, type: 'plate', mix: 0.1 } },
  solo: { chorus: CHORUS_OFF, delay: { on: true, timeMs: 380, feedback: 0.32, mix: 0.24 }, reverb: { on: true, type: 'plate', mix: 0.18 } },
};

const sameFields = (a: object | undefined, b: object): boolean =>
  !!a && Object.entries(b).every(([key, value]) => (a as Record<string, unknown>)[key] === value);

/**
 * Saved presets get the drier effects, one effect at a time: only an effect still exactly as it
 * first was (the user never touched it) is changed.
 */
export function upgradeFirstEffects<P extends { id: string; chorus?: object; delay?: object; reverb?: object }>(saved: readonly P[]): P[] {
  return saved.map((preset) => {
    const first = FIRST_EFFECTS[preset.id];
    const now = DEFAULT_PRESETS.find((p) => p.id === preset.id);
    if (!first || !now) return preset;
    const out = { ...preset };
    for (const fx of ['chorus', 'delay', 'reverb'] as const) {
      if (sameFields(preset[fx], first[fx])) (out as Record<string, unknown>)[fx] = { ...now[fx] };
    }
    return out;
  });
}

/**
 * Saved presets that still play their first amp get the new one, with its drive and level (both
 * belong to the amp). A preset whose amp was chosen by hand stays as it is, and so does everything
 * else in every preset (gate, EQ, cabinet, effects, name).
 */
export function upgradeFirstAmps<P extends { id: string; amp: Partial<AmpSettings> }>(saved: readonly P[]): P[] {
  return saved.map((preset) => {
    const first = FIRST_AMPS[preset.id];
    const now = DEFAULT_PRESETS.find((p) => p.id === preset.id);
    if (!first || !now || preset.amp?.model !== first.model) return preset;
    return { ...preset, amp: { ...preset.amp, model: now.amp.model, inputDb: now.amp.inputDb, levelDb: now.amp.levelDb } };
  });
}

export function mergePreset(base: Preset, patch: PresetPatch): Preset {
  return {
    ...base,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.cab !== undefined && { cab: patch.cab }),
    amp: { ...base.amp, ...patch.amp },
    chorus: { ...base.chorus, ...patch.chorus },
    delay: { ...base.delay, ...patch.delay },
    reverb: { ...base.reverb, ...patch.reverb },
  };
}

/**
 * Replaces a deleted user model / cabinet in a preset with the preset's own default. The default
 * amp comes back with its own drive and level: those were set for the file that is gone.
 */
export function forgetAssetIn(preset: Preset, id: string, defaults: Preset): Preset {
  const patch: PresetPatch = {};
  if (preset.amp.model === id) {
    patch.amp = { model: defaults.amp.model, inputDb: defaults.amp.inputDb, levelDb: defaults.amp.levelDb };
  }
  if (preset.cab === id) patch.cab = defaults.cab;
  return patch.amp || patch.cab ? mergePreset(preset, patch) : preset;
}

/**
 * The name a preset is shown with: a built-in one's in the interface's language (`names` is
 * `t.amp.presets`), any other its own.
 */
export function presetName(preset: Pick<Preset, 'id' | 'name'>, names: Readonly<Record<string, string>>): string {
  return Object.hasOwn(names, preset.id) ? names[preset.id] : preset.name;
}

/** Index of the neighbouring preset, wrapping around. */
export function nextIndex(index: number, direction: number, count: number): number {
  return (((index + direction) % count) + count) % count;
}
