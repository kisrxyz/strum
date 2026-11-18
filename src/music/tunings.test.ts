import { describe, expect, it } from 'vitest';
import { STANDARD_TUNING } from '../dsp/notes';
import { setLanguage } from '../i18n';
import { TUNING_ORDER, TUNINGS } from './tunings';

describe('tunings', () => {
  it('has the three tunings, 6th string first', () => {
    expect(TUNINGS.standard.strings).toEqual([40, 45, 50, 55, 59, 64]);
    expect(TUNINGS.eb.strings).toEqual([39, 44, 49, 54, 58, 63]);
    expect(TUNINGS.dropd.strings).toEqual([38, 45, 50, 55, 59, 64]);
    expect(TUNINGS.standard.strings).toEqual([...STANDARD_TUNING]);
  });

  it('names them in the current language and moves shapes only for E♭', () => {
    try {
      setLanguage('en');
      expect(TUNINGS.standard).toMatchObject({ name: 'Standard', shift: 0 });
      expect(TUNINGS.eb).toMatchObject({ name: 'E♭ (half step down)', shift: -1 });
      expect(TUNINGS.dropd).toMatchObject({ name: 'Drop D', shift: 0 });
      setLanguage('ru');
      expect(TUNINGS.standard.name).toBe('Стандартный');
      expect(TUNINGS.eb.name).toBe('E♭ (на полтона ниже)');
    } finally {
      setLanguage('en');
    }
  });

  it('cycles in a fixed order', () => {
    expect(TUNING_ORDER).toEqual(['standard', 'eb', 'dropd']);
  });
});
