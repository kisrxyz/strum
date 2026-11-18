import { describe, expect, it } from 'vitest';
import { BUILTIN_IRS, BUILTIN_MODELS, modelDefaults } from '../audio/assets';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import {
  DEFAULT_PRESETS,
  FIRST_AMPS,
  FIRST_EFFECTS,
  forgetAssetIn,
  mergePreset,
  nextIndex,
  presetName,
  upgradeFirstAmps,
  upgradeFirstEffects,
} from './presets';

describe('the amps of 2026-11-16', () => {
  it('replace a preset’s first amp with its drive and level, and keep the rest', () => {
    const first = DEFAULT_PRESETS.map((p) => mergePreset(p, { amp: { ...FIRST_AMPS[p.id], gateDb: -50 }, reverb: { mix: 0.05 } }));
    const upgraded = upgradeFirstAmps(first);
    upgraded.forEach((preset, i) => {
      const now = DEFAULT_PRESETS[i];
      expect(preset.amp).toMatchObject({ model: now.amp.model, inputDb: now.amp.inputDb, levelDb: now.amp.levelDb, gateDb: -50 });
      expect(preset.reverb.mix).toBe(0.05);
      expect(preset.amp.model).not.toBe(FIRST_AMPS[now.id].model);
    });
  });

  it('leave an amp chosen by hand, and presets they do not know, alone', () => {
    const own = mergePreset(DEFAULT_PRESETS[2], { amp: { model: 'user:abc', inputDb: 3, levelDb: 2 } });
    const odd = { ...DEFAULT_PRESETS[0], id: 'mine', amp: { ...DEFAULT_PRESETS[0].amp, model: 'nam:jc' } };
    expect(upgradeFirstAmps([own, odd])).toEqual([own, odd]);
  });

  it('all have the hum filter on, and the gate that finds the noise itself', () => {
    expect(DEFAULT_PRESETS.every((p) => p.amp.hum)).toBe(true);
    expect(DEFAULT_PRESETS.every((p) => p.amp.gateAuto)).toBe(true);
  });
});

describe('the drier effects of 2026-11-16', () => {
  it('replace each effect still as it first was, and only those', () => {
    const first = DEFAULT_PRESETS.map((p) => ({ ...p, ...FIRST_EFFECTS[p.id] }));
    // The clean one's reverb was turned by hand: it stays; its chorus is new.
    first[0] = { ...first[0], reverb: { ...first[0].reverb, mix: 0.3 } };
    const upgraded = upgradeFirstEffects(first);
    expect(upgraded[0].chorus).toEqual(DEFAULT_PRESETS[0].chorus);
    expect(upgraded[0].reverb.mix).toBe(0.3);
    expect(upgraded[3].delay).toEqual(DEFAULT_PRESETS[3].delay);
    expect(upgraded[3].reverb).toEqual(DEFAULT_PRESETS[3].reverb);
    upgraded.slice(1).forEach((preset, i) => expect(preset.reverb).toEqual(DEFAULT_PRESETS[i + 1].reverb));
  });

  it('are drier than the first ones', () => {
    for (const preset of DEFAULT_PRESETS) {
      const first = FIRST_EFFECTS[preset.id];
      expect(preset.reverb.mix).toBeLessThan(first.reverb.mix);
      expect(preset.chorus.mix).toBeLessThanOrEqual(first.chorus.mix);
      expect(preset.delay.mix).toBeLessThanOrEqual(first.delay.mix);
    }
  });
});

describe('default presets', () => {
  it('are the four presets from the spec', () => {
    expect(DEFAULT_PRESETS.map((p) => p.id)).toEqual(['clean-chorus', 'crunch', 'drive', 'solo']);
  });

  it('show a built-in preset by its name in the language, any other by its own name', () => {
    expect(DEFAULT_PRESETS.map((p) => presetName(p, en.amp.presets))).toEqual(['Clean chorus', 'Crunch', 'Drive', 'Lead']);
    expect(DEFAULT_PRESETS.map((p) => presetName(p, ru.amp.presets))).toEqual(['Чистый с хорусом', 'Кранч', 'Перегруз', 'Соло']);
    // A preset saved before the languages keeps its Russian name in the store: the language wins.
    expect(presetName({ id: 'crunch', name: 'Кранч' }, en.amp.presets)).toBe('Crunch');
    expect(presetName({ id: 'mine', name: 'Мой звук' }, en.amp.presets)).toBe('Мой звук');
    expect(presetName({ id: 'toString', name: 'Own' }, en.amp.presets)).toBe('Own');
  });

  it('only use built-in models and cabinets', () => {
    const models = new Set(BUILTIN_MODELS.map((m) => m.id));
    const cabs = new Set(BUILTIN_IRS.map((c) => c.id));
    for (const p of DEFAULT_PRESETS) {
      expect(models.has(p.amp.model), p.amp.model).toBe(true);
      expect(cabs.has(p.cab), p.cab).toBe(true);
    }
  });

  it('match their character: chorus on the clean one, delay on the solo one', () => {
    expect(DEFAULT_PRESETS[0].chorus.on).toBe(true);
    expect(DEFAULT_PRESETS[3].delay.on).toBe(true);
    expect(DEFAULT_PRESETS[1].amp.inputDb).toBeLessThan(DEFAULT_PRESETS[2].amp.inputDb);
  });

  it('have unique ids', () => {
    expect(new Set(DEFAULT_PRESETS.map((p) => p.id)).size).toBe(DEFAULT_PRESETS.length);
  });
});

describe('an amp picked by hand in the list', () => {
  it('comes with its own drive and level, every built-in one', () => {
    for (const model of BUILTIN_MODELS) {
      const own = modelDefaults(model.id);
      expect(own, model.id).not.toBeNull();
      expect(own!.inputDb, model.id).toBeGreaterThanOrEqual(-24);
      expect(own!.inputDb, model.id).toBeLessThanOrEqual(12);
      expect(own!.levelDb, model.id).toBeGreaterThanOrEqual(-12);
      expect(own!.levelDb, model.id).toBeLessThanOrEqual(12);
    }
  });

  it('is driven as the preset that plays it by default drives it', () => {
    // The levels may differ a little: the preset's own EQ and effects are in its level.
    for (const preset of DEFAULT_PRESETS) {
      const own = modelDefaults(preset.amp.model)!;
      expect(own.inputDb, preset.id).toBe(preset.amp.inputDb);
      expect(Math.abs(own.levelDb - preset.amp.levelDb), preset.id).toBeLessThanOrEqual(1.5);
    }
  });

  it('knows nothing of the user’s own file', () => {
    expect(modelDefaults('user:abc')).toBeNull();
  });
});

describe('preset helpers', () => {
  it('wraps the preset index in both directions', () => {
    expect(nextIndex(3, 1, 4)).toBe(0);
    expect(nextIndex(0, -1, 4)).toBe(3);
    expect(nextIndex(1, 1, 4)).toBe(2);
  });

  it('sends presets that used a deleted file back to their own defaults', () => {
    const def = DEFAULT_PRESETS[2];
    const own = mergePreset(def, { amp: { model: 'user:1', inputDb: -6, levelDb: 9, gateDb: -50 }, cab: 'user:2' });
    expect(forgetAssetIn(own, 'user:1', def).amp.model).toBe(def.amp.model);
    // The default amp comes back with its own drive and level (set for the file that is gone); the rest stays.
    expect(forgetAssetIn(own, 'user:1', def).amp).toMatchObject({ inputDb: def.amp.inputDb, levelDb: def.amp.levelDb, gateDb: -50 });
    expect(forgetAssetIn(own, 'user:1', def).cab).toBe('user:2');
    expect(forgetAssetIn(own, 'user:2', def).cab).toBe(def.cab);
    expect(forgetAssetIn(own, 'user:3', def)).toBe(own);
  });

  it('merges a partial change without touching the original', () => {
    const base = DEFAULT_PRESETS[0];
    const next = mergePreset(base, { amp: { inputDb: 3 }, chorus: { on: false } });
    expect(next.amp.inputDb).toBe(3);
    expect(next.amp.model).toBe(base.amp.model);
    expect(next.chorus.on).toBe(false);
    expect(next.chorus.rate).toBe(base.chorus.rate);
    expect(base.chorus.on).toBe(true);
    expect(base.amp.inputDb).not.toBe(3);
  });
});
