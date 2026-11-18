import { describe, expect, it } from 'vitest';
import { validateNamJson } from './namMeta';

describe('validateNamJson', () => {
  it('accepts a model file', () => {
    expect(validateNamJson('{"architecture":"WaveNet","config":{},"weights":[0.1]}')).toEqual({
      ok: true,
      architecture: 'WaveNet',
    });
  });

  it('explains what is wrong with other files', () => {
    const notJson = validateNamJson('not json');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toBe('This file can’t be read as an amp model.');
    expect(validateNamJson('{}').ok).toBe(false);
    expect(validateNamJson('[1,2]').ok).toBe(false);
  });
});
