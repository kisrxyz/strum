import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n';
import { fileNameFromDisposition, fmtPitch, fmtSpeed, fmtTime } from './format';

describe('fmtTime', () => {
  it('shows minutes and seconds, and hours when needed', () => {
    expect(fmtTime(83.4)).toBe('1:23');
    expect(fmtTime(5)).toBe('0:05');
    expect(fmtTime(3725)).toBe('1:02:05');
    expect(fmtTime(-3)).toBe('0:00');
  });
});

describe('fmtSpeed / fmtPitch', () => {
  it('formats speed in percent, as the language writes it', () => {
    setLanguage('ru');
    expect(fmtSpeed(0.8)).toBe('80 %');
    expect(fmtSpeed(0.85)).toBe('85 %');
    setLanguage('en');
    expect(fmtSpeed(0.8)).toBe('80%');
  });

  it('formats pitch in semitones with a real minus and the decimal mark of the language', () => {
    setLanguage('en');
    expect(fmtPitch(2, -5)).toBe('+1.95');
    setLanguage('ru');
    expect(fmtPitch(0, 0)).toBe('0');
    expect(fmtPitch(-1, 0)).toBe('−1');
    expect(fmtPitch(2, -5)).toBe('+1,95');
    expect(fmtPitch(0, 15)).toBe('+0,15');
    setLanguage('en');
  });
});

describe('fileNameFromDisposition', () => {
  it('prefers the UTF-8 name', () => {
    expect(fileNameFromDisposition("attachment; filename=\"x.mp3\"; filename*=UTF-8''%D0%9A.mp3")).toBe('К.mp3');
  });

  it('falls back to the plain name, or nothing', () => {
    expect(fileNameFromDisposition('attachment; filename="backing-track.mp3"')).toBe('backing-track.mp3');
    expect(fileNameFromDisposition(null)).toBeNull();
    expect(fileNameFromDisposition('inline')).toBeNull();
  });
});
