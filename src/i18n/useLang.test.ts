import { describe, expect, it, vi } from 'vitest';

// The settings store reads localStorage when the module loads, so the stub comes before the import.
vi.hoisted(() => {
  const data = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
});

const { useSettings } = await import('../state/settings');
const { L } = await import('./index');
const { bindLanguage } = await import('./useLang');

describe('bindLanguage', () => {
  it('makes L() follow the settings, at once and on every switch', () => {
    useSettings.getState().setLang('ru');
    bindLanguage();
    expect(L().common.on).toBe('вкл');
    useSettings.getState().setLang('en');
    expect(L().common.on).toBe('on');
    useSettings.getState().setLang('ru');
    expect(L().common.cancel).toBe('Отмена');
  });
});
