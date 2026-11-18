import { afterEach, describe, expect, it } from 'vitest';
import { L, setLanguage } from './index';
import { isServiceMessage, messageText } from './messages';

afterEach(() => setLanguage('en'));

describe('messageText', () => {
  it('shows a plain string as it is (an older service still sends Russian)', () => {
    expect(messageText('Готово')).toBe('Готово');
  });

  it('turns a known code into words of the current language', () => {
    setLanguage('en');
    const en = messageText({ code: 'requestFailed', params: { status: 500 } });
    setLanguage('ru');
    const ru = messageText({ code: 'requestFailed', params: { status: 500 } });
    expect(en).toContain('500');
    expect(ru).toContain('500');
    expect(en).not.toBe(ru);
  });

  it('names an unknown code instead of failing', () => {
    expect(messageText({ code: 'nope' })).toBe(L().service.unknown('nope'));
  });

  it('is empty for nothing', () => {
    expect(messageText(undefined)).toBe('');
    expect(messageText(null)).toBe('');
  });
});

describe('isServiceMessage', () => {
  it('knows a message from a string or junk', () => {
    expect(isServiceMessage({ code: 'offline' })).toBe(true);
    expect(isServiceMessage({ code: 'x', params: { a: 1 } })).toBe(true);
    expect(isServiceMessage('offline')).toBe(false);
    expect(isServiceMessage({ text: 'x' })).toBe(false);
    expect(isServiceMessage(null)).toBe(false);
  });
});
