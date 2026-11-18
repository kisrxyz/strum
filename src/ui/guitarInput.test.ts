import { afterEach, describe, expect, it } from 'vitest';
import type { LatencyEstimate } from '../dsp/latency';
import { L, setLanguage } from '../i18n';
import {
  bufferLabel,
  bufferMs,
  bufferOptions,
  canGrowBuffer,
  clicksLine,
  clicksSince,
  fmtMs1,
  latencyAdvice,
  latencyBadgeTitle,
  latencySource,
  latencyTotalText,
  micHint,
  nativeDeviceNames,
  nativeLatencyLine,
  pickerLayout,
  routeNote,
} from './guitarInput';

afterEach(() => setLanguage('en'));

const native = (inputMs: number, outputMs: number): LatencyEstimate => ({
  inputMs,
  processingMs: 0,
  outputMs,
  totalMs: Math.round((inputMs + outputMs) * 10) / 10,
  inputEstimated: false,
});

describe('fmtMs1', () => {
  it('keeps one decimal and drops a zero one', () => {
    expect(fmtMs1(2.6667)).toBe('2.7');
    expect(fmtMs1(8)).toBe('8');
    expect(fmtMs1(8.04)).toBe('8');
    expect(fmtMs1(0)).toBe('0');
  });

  it('writes the decimal with a comma in Russian', () => {
    setLanguage('ru');
    expect(fmtMs1(2.6667)).toBe('2,7');
    expect(fmtMs1(8)).toBe('8');
  });
});

describe('the buffer', () => {
  it('lasts frames / 48 000 s', () => {
    expect(bufferMs(48)).toBeCloseTo(1, 10);
    expect(bufferMs(128)).toBeCloseTo(2.6667, 3);
  });

  it('is labelled in frames and ms at 48 kHz', () => {
    expect(bufferOptions([32, 64, 128, 256])).toEqual([
      { value: 32, label: '32 · ≈ 0.7 ms' },
      { value: 64, label: '64 · ≈ 1.3 ms' },
      { value: 128, label: '128 · ≈ 2.7 ms' },
      { value: 256, label: '256 · ≈ 5.3 ms' },
    ]);
    expect(bufferLabel(96)).toBe('96 · ≈ 2 ms');
    setLanguage('ru');
    expect(bufferLabel(128)).toBe('128 · ≈ 2,7 мс');
  });
});

describe('which controls show', () => {
  it('shows the card and buffer in ASIO, the system pickers in System audio, never both', () => {
    expect(pickerLayout('native')).toEqual({ native: true, browser: false });
    expect(pickerLayout('browser')).toEqual({ native: false, browser: true });
  });
});

describe('the native cards', () => {
  it('lists what the engine reports', () => {
    expect(nativeDeviceNames(['M-Track Solo', 'Realtek ASIO'], null)).toEqual(['M-Track Solo', 'Realtek ASIO']);
    expect(nativeDeviceNames(['M-Track Solo'], 'M-Track Solo')).toEqual(['M-Track Solo']);
  });

  it('keeps a chosen card that is not plugged in, so the picker does not show another one', () => {
    expect(nativeDeviceNames(['Realtek ASIO'], 'M-Track Solo')).toEqual(['Realtek ASIO', 'M-Track Solo']);
    expect(nativeDeviceNames([], 'M-Track Solo')).toEqual(['M-Track Solo']);
  });
});

describe('latency text', () => {
  it('writes the native line as the driver reports it', () => {
    expect(nativeLatencyLine(native(3.1, 4.2))).toBe('Latency ≈ 7.3 ms (in 3.1 + out 4.2)');
    expect(nativeLatencyLine(native(3, 5))).toBe('Latency ≈ 8 ms (in 3 + out 5)');
    setLanguage('ru');
    expect(nativeLatencyLine(native(3.1, 4.2))).toBe('Задержка ≈ 7,3 мс (вход 3,1 + выход 4,2)');
  });

  it('shows the native total with a decimal and the browser total whole', () => {
    expect(latencyTotalText(native(3.1, 4.2), 'native')).toBe('≈ 7.3 ms');
    expect(latencyTotalText({ ...native(3.1, 4.2), totalMs: 23.4 }, 'browser')).toBe('≈ 23 ms');
    expect(latencyTotalText({ ...native(3.1, 4.2), totalMs: 23.4 }, null)).toBe('≈ 23 ms');
  });

  it('sends a system-audio user to the headphones and a native one to the buffer', () => {
    expect(latencyAdvice('bad', 'browser')).toBe('Noticeable. Plug the headphones into the sound card and close other programs.');
    expect(latencyAdvice('ok', null)).toContain('headphones');
    expect(latencyAdvice('great', 'native')).toBe(latencyAdvice('great', 'browser'));
    expect(latencyAdvice('ok', 'native')).not.toContain('headphones');
    expect(latencyAdvice('bad', 'native')).toContain('buffer');
  });

  it('says where the number comes from', () => {
    expect(latencySource('native')).toBe('Reported by the sound card driver');
    expect(latencySource('browser')).toBe('Estimated by the system');
    expect(latencyBadgeTitle('native')).toContain('driver');
    expect(latencyBadgeTitle('browser')).toContain('estimated by the system');
    expect(latencyBadgeTitle(null)).toContain('estimated by the system');
  });
});

describe('clicks', () => {
  it('counts what happened since the baseline', () => {
    expect(clicksSince(0, 0)).toEqual({ baseline: 0, clicks: 0 });
    expect(clicksSince(0, 3)).toEqual({ baseline: 0, clicks: 3 });
    expect(clicksSince(5, 5)).toEqual({ baseline: 5, clicks: 0 });
    expect(clicksSince(5, 7)).toEqual({ baseline: 5, clicks: 2 });
  });

  it('starts again when the engine counts from zero after the card was reopened', () => {
    expect(clicksSince(5, 0)).toEqual({ baseline: 0, clicks: 0 });
    expect(clicksSince(5, 2)).toEqual({ baseline: 0, clicks: 2 });
  });

  it('says nothing until something clicked', () => {
    expect(clicksLine(0, true)).toBeNull();
    expect(clicksLine(-1, true)).toBeNull();
  });

  it('advises a bigger buffer, word for word', () => {
    expect(clicksLine(3, true)).toBe('There were clicks (3). Try a bigger buffer.');
  });

  it('does not advise a bigger buffer when it is the biggest', () => {
    expect(canGrowBuffer(128, [32, 64, 128, 256])).toBe(true);
    expect(canGrowBuffer(256, [32, 64, 128, 256])).toBe(false);
    expect(clicksLine(3, false)).toBe('There were clicks (3). Close other programs.');
  });
});

describe('why the guitar plays elsewhere', () => {
  const toast = 'ASIO did not start. The guitar plays through system audio.';

  it('gives the toast text when the path is not the one chosen', () => {
    expect(routeNote('native', 'browser', toast)).toBe(toast);
  });

  it('says nothing when the path is the one chosen, not started, or there is nothing to say', () => {
    expect(routeNote('native', 'native', null)).toBeNull();
    expect(routeNote('native', 'native', toast)).toBeNull();
    expect(routeNote('browser', 'browser', null)).toBeNull();
    expect(routeNote('native', null, toast)).toBeNull();
    expect(routeNote('native', 'browser', null)).toBeNull();
  });
});

describe('the start screen', () => {
  it('speaks of the microphone in System audio', () => {
    expect(micHint('browser', 'off')).toBe(L().input.micHint);
  });

  it('says nothing about it in ASIO while the engine is reached or being reached', () => {
    expect(micHint('native', 'off')).toBeNull();
    expect(micHint('native', 'connecting')).toBeNull();
    expect(micHint('native', 'ready')).toBeNull();
  });

  it('warns again when ASIO did not start and the browser takes the guitar', () => {
    expect(micHint('native', 'lost')).toBe(L().input.micHint);
  });
});
