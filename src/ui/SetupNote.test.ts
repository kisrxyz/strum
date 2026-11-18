import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import type { ComponentPart, ComponentsStatus } from '../song/types';
import { setupLine, sizeText } from './SetupNote';

const part = (patch: Partial<ComponentPart> = {}): ComponentPart => ({
  state: 'ready',
  stage: '',
  done: 0,
  total: 0,
  unit: 'bytes',
  error: null,
  flavor: 'cuda',
  ...patch,
});
const status = (songs: Partial<ComponentPart>, words: Partial<ComponentPart> = {}): ComponentsStatus => ({
  canInstall: true,
  songs: part(songs),
  words: part({ state: 'missing', ...words }),
});

describe('setupLine', () => {
  it('says nothing in the author’s copy or when all is there', () => {
    expect(setupLine(undefined, en, 'en')).toBeNull();
    expect(setupLine({ ...status({ state: 'missing' }), canInstall: false }, en, 'en')).toBeNull();
    expect(setupLine(status({}), en, 'en')).toBeNull();
  });

  it('counts the download in GB, then the models', () => {
    const packages = setupLine(status({ state: 'installing', stage: 'packages', done: 1.25e9, total: 3.4e9 }), en, 'en');
    expect(packages?.text).toBe('Downloading song separation: 1.3 GB of 3.4 GB');
    expect(packages?.fraction).toBeCloseTo(1.25 / 3.4);
    const models = setupLine(status({ state: 'installing', stage: 'weights', unit: 'steps', done: 1, total: 3 }), en, 'en');
    expect(models?.text).toBe('Downloading song separation: model 2 of 3');
  });

  it('offers the download with its size, and nothing starts by itself', () => {
    const missing = setupLine(status({ state: 'missing', estimate: 3.1e9 }), en, 'en');
    expect(missing?.text).toBe('Song separation is not downloaded yet: about 3.1 GB.');
    expect(missing?.action).toBe('download');
    expect(missing?.hint).toContain('The amp, the tuner and tabs work without it.');
    expect(setupLine(status({ state: 'missing' }), ru, 'ru')?.text).toBe('Разделение песен ещё не скачано.');
  });

  it('offers to try again after a failure, with the reason', () => {
    const failed = setupLine(
      status({ state: 'failed', error: { code: 'components.failed', params: { reason: 'timed out' } } }),
      en,
      'en',
    );
    expect(failed?.action).toBe('retry');
    expect(failed?.error).toBe('The download stopped (timed out).');
  });

  it('shows the words model while it downloads', () => {
    const line = setupLine(status({}, { state: 'installing', done: 5e8, total: 2.9e9 }), ru, 'ru');
    expect(line?.part).toBe('words');
    expect(line?.text).toBe('Загрузка модели слов: 500 МБ из 2,9 ГБ');
  });

  it('writes sizes in the language of the app', () => {
    expect(sizeText(2.94e9, ru, 'ru')).toBe('2,9 ГБ');
    expect(sizeText(126_738_207, en, 'en')).toBe('127 MB');
  });
});
