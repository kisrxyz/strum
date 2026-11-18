import { describe, expect, it } from 'vitest';
import { bootPlan } from './settingsFile';

describe('bootPlan', () => {
  it('takes the file when it differs from the browser copy', () => {
    expect(bootPlan({ kind: 'file', text: '{"a":1}' }, '{"a":0}')).toEqual({ seed: '{"a":1}' });
    expect(bootPlan({ kind: 'file', text: '{"a":1}' }, null)).toEqual({ seed: '{"a":1}' });
  });

  it('does nothing when both agree', () => {
    expect(bootPlan({ kind: 'file', text: '{"a":1}' }, '{"a":1}')).toEqual({});
  });

  it('uploads the browser copy once when there is no file yet (the settings of before 2026-11-18)', () => {
    expect(bootPlan({ kind: 'none' }, '{"a":0}')).toEqual({ upload: '{"a":0}' });
    expect(bootPlan({ kind: 'none' }, null)).toEqual({});
  });

  it('keeps the browser copy while the service is down', () => {
    expect(bootPlan({ kind: 'down' }, '{"a":0}')).toEqual({});
  });
});
