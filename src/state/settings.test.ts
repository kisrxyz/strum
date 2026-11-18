import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The settings store reads localStorage when the module loads, so the stub comes before the import.
const storage = vi.hoisted(() => {
  const data = new Map<string, string>();
  const stub = {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  Object.assign(globalThis, { localStorage: stub });
  return stub;
});

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** A fresh copy of the module, as if the page had just loaded in a browser with this user agent. */
async function load(userAgent: string, saved?: object, version = 1) {
  vi.resetModules();
  vi.stubGlobal('navigator', { userAgent });
  storage.data.clear();
  if (saved) storage.data.set('kvartirnik-settings', JSON.stringify({ state: saved, version }));
  return import('./settings');
}

describe('presets saved before the amps of 2026-11-16', () => {
  /** The presets as version 1 saved them (the first amps and effects; no hum filter, no «Шумодав сам»). */
  const firstPresets = async () => {
    const { DEFAULT_PRESETS, FIRST_AMPS, FIRST_EFFECTS } = await import('./presets');
    return DEFAULT_PRESETS.map((p) => {
      const { hum: _hum, gateAuto: _gateAuto, ...amp } = { ...p.amp, ...FIRST_AMPS[p.id] };
      return { ...p, ...FIRST_EFFECTS[p.id], amp };
    });
  };

  it('get the new amps unless an amp was chosen by hand; the rest of each preset stays', async () => {
    const saved = await firstPresets();
    saved[1] = { ...saved[1], amp: { ...saved[1].amp, gateDb: -52 } };
    saved[3] = { ...saved[3], amp: { ...saved[3].amp, model: 'nam:ac10' } };
    const { useSettings } = await load(WINDOWS, { presets: saved, presetIndex: 1 });
    const presets = useSettings.getState().presets;
    expect(presets.map((p) => p.amp.model)).toEqual(['nam:twin', 'nam:jcm2000', 'nam:jcm900', 'nam:ac10']);
    expect(presets[1].amp).toMatchObject({ gateDb: -52, inputDb: -15, levelDb: 1 });
    expect(presets.every((p) => p.amp.hum)).toBe(true);
    // «Шумодав сам» is on in every saved preset too, over whatever threshold was set by hand.
    expect(presets.every((p) => p.amp.gateAuto)).toBe(true);
    expect(useSettings.getState().presetIndex).toBe(1);
    // The effects got drier too (none was touched here).
    const { DEFAULT_PRESETS } = await import('./presets');
    expect(presets.map((p) => p.reverb.mix)).toEqual(DEFAULT_PRESETS.map((p) => p.reverb.mix));
    expect(presets[0].chorus).toEqual(DEFAULT_PRESETS[0].chorus);
    // Saved again as the current version.
    expect(JSON.parse(storage.data.get('kvartirnik-settings')!).version).toBe(4);
  });

  it('saved by version 2 keep their amps and get only the drier effects', async () => {
    const saved = await firstPresets();
    const { useSettings } = await load(WINDOWS, { presets: saved }, 2);
    const presets = useSettings.getState().presets;
    expect(presets[0].amp.model).toBe('nam:jc');
    expect(presets[0].chorus.mix).toBe(0.35);
  });

  it('are left alone once saved by version 3 (the old amp and effects chosen again on purpose)', async () => {
    const saved = await firstPresets();
    const { useSettings } = await load(WINDOWS, { presets: saved }, 3);
    expect(useSettings.getState().presets[0].amp.model).toBe('nam:jc');
    expect(useSettings.getState().presets[0].chorus.mix).toBe(0.5);
  });
});

beforeEach(() => storage.data.clear());
afterEach(() => vi.unstubAllGlobals());

describe('the guitar engine setting', () => {
  it('defaults to native on Windows and browser elsewhere', async () => {
    expect((await load(WINDOWS)).useSettings.getState().guitarEngine).toBe('native');
    expect((await load(MAC)).useSettings.getState().guitarEngine).toBe('browser');
    expect((await load(LINUX)).useSettings.getState().guitarEngine).toBe('browser');
    expect((await load('')).useSettings.getState().guitarEngine).toBe('browser');
  });

  it('has the native device on «Автоматически» and a 128-sample buffer by default', async () => {
    const { useSettings } = await load(WINDOWS);
    expect(useSettings.getState().nativeDevice).toBeNull();
    expect(useSettings.getState().nativeBuffer).toBe(128);
  });

  it('remembers what the author chose, whatever the system', async () => {
    const { useSettings } = await load(WINDOWS, { guitarEngine: 'browser', nativeDevice: 'ASIO4ALL v2', nativeBuffer: 64 });
    expect(useSettings.getState()).toMatchObject({ guitarEngine: 'browser', nativeDevice: 'ASIO4ALL v2', nativeBuffer: 64 });
    const mac = await load(MAC, { guitarEngine: 'native' });
    expect(mac.useSettings.getState().guitarEngine).toBe('native');
  });

  it('gives an old settings file without the new fields their defaults', async () => {
    const { useSettings } = await load(WINDOWS, { masterDb: -5, a4: 442 });
    expect(useSettings.getState()).toMatchObject({ masterDb: -5, a4: 442, guitarEngine: 'native', nativeBuffer: 128 });
  });

  it('ignores values it does not know', async () => {
    const { useSettings } = await load(WINDOWS, { guitarEngine: 'asio', nativeDevice: 7, nativeBuffer: 999 });
    expect(useSettings.getState()).toMatchObject({ guitarEngine: 'native', nativeDevice: null, nativeBuffer: 128 });
  });

  it('changes and saves the engine, the device and the buffer', async () => {
    const { useSettings } = await load(WINDOWS);
    useSettings.getState().setGuitarEngine('browser');
    useSettings.getState().setNativeDevice('ASIO4ALL v2');
    useSettings.getState().setNativeBuffer(256);
    expect(useSettings.getState()).toMatchObject({ guitarEngine: 'browser', nativeDevice: 'ASIO4ALL v2', nativeBuffer: 256 });
    const saved = JSON.parse(storage.data.get('kvartirnik-settings')!) as { state: Record<string, unknown> };
    expect(saved.state).toMatchObject({ guitarEngine: 'browser', nativeDevice: 'ASIO4ALL v2', nativeBuffer: 256 });

    useSettings.getState().setNativeDevice(null);
    expect(useSettings.getState().nativeDevice).toBeNull();
  });

  it('keeps the buffer to the four sizes the engine knows', async () => {
    const { useSettings } = await load(WINDOWS);
    for (const size of [32, 64, 128, 256] as const) {
      useSettings.getState().setNativeBuffer(size);
      expect(useSettings.getState().nativeBuffer).toBe(size);
    }
    useSettings.getState().setNativeBuffer(100 as 64);
    expect(useSettings.getState().nativeBuffer).toBe(256);
  });
});

describe('«Подстроить под мою гитару»', () => {
  it('starts at 0 dB, keeps a set trim in its range and in half decibels, and saves it', async () => {
    const { useSettings } = await load(WINDOWS);
    expect(useSettings.getState().inputTrimDb).toBe(0);
    useSettings.getState().setInputTrim(8.26);
    expect(useSettings.getState().inputTrimDb).toBe(8.5);
    useSettings.getState().setInputTrim(99);
    expect(useSettings.getState().inputTrimDb).toBe(24);
    const saved = JSON.parse(storage.data.get('kvartirnik-settings')!) as { state: Record<string, unknown> };
    expect(saved.state.inputTrimDb).toBe(24);
  });

  it('reads a saved trim back, and a broken one as 0 dB', async () => {
    expect((await load(WINDOWS, { inputTrimDb: 12.5 }, 3)).useSettings.getState().inputTrimDb).toBe(12.5);
    expect((await load(WINDOWS, { inputTrimDb: 'громко' }, 3)).useSettings.getState().inputTrimDb).toBe(0);
    expect((await load(WINDOWS, { inputTrimDb: -80 }, 3)).useSettings.getState().inputTrimDb).toBe(-12);
  });
});

describe('defaultGuitarEngine', () => {
  it('looks for Windows in the user agent', async () => {
    const { defaultGuitarEngine } = await load(WINDOWS);
    expect(defaultGuitarEngine(WINDOWS)).toBe('native');
    expect(defaultGuitarEngine(MAC)).toBe('browser');
    expect(defaultGuitarEngine(undefined)).toBe('browser');
  });
});

describe('the language', () => {
  it('is English on a fresh install, even on a Russian system', async () => {
    const { useSettings } = await load(WINDOWS);
    expect(useSettings.getState().language).toBe('en');
  });

  it('is Russian for settings saved before languages existed', async () => {
    const { useSettings } = await load(WINDOWS, { masterDb: -3 }, 3);
    expect(useSettings.getState().language).toBe('ru');
    expect(useSettings.getState().masterDb).toBe(-3);
  });

  it('is kept once saved, and an unknown one falls back to English', async () => {
    const { useSettings } = await load(WINDOWS, { language: 'en' }, 4);
    expect(useSettings.getState().language).toBe('en');
    useSettings.getState().setLang('ru');
    expect(JSON.parse(storage.data.get('kvartirnik-settings')!).state.language).toBe('ru');
    const again = await load(WINDOWS, { language: 'de' }, 4);
    expect(again.useSettings.getState().language).toBe('en');
  });
});

describe('the mains and the raw input track', () => {
  it('find the mains by ear and keep no raw input on a fresh install', async () => {
    const { useSettings } = await load(WINDOWS);
    expect(useSettings.getState()).toMatchObject({ mains: 'auto', mainsHz: 50, saveRawInput: false });
  });

  it('keep the raw input for the author, whose settings came before', async () => {
    const { useSettings } = await load(WINDOWS, { masterDb: 0 }, 3);
    expect(useSettings.getState().saveRawInput).toBe(true);
  });

  it('remember a choice made by hand and the mains heard, and ignore junk', async () => {
    const { useSettings } = await load(WINDOWS, { mains: 60, mainsHz: 60, saveRawInput: true }, 4);
    expect(useSettings.getState()).toMatchObject({ mains: 60, mainsHz: 60, saveRawInput: true });
    const again = await load(WINDOWS, { mains: 55, mainsHz: 'x' }, 4);
    expect(again.useSettings.getState()).toMatchObject({ mains: 'auto', mainsHz: 50 });
    again.useSettings.getState().setMains(60);
    again.useSettings.getState().setMainsHeard(60);
    again.useSettings.getState().setSaveRawInput(true);
    expect(again.useSettings.getState()).toMatchObject({ mains: 60, mainsHz: 60, saveRawInput: true });
  });
});
