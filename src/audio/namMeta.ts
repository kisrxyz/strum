// Checking that a dropped file really is a NAM model.
import { L } from '../i18n';

export type NamValidation = { ok: true; architecture: string } | { ok: false; reason: string };

export function validateNamJson(text: string): NamValidation {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: L().amp.notJson };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: L().amp.notModel };
  }
  const architecture = (data as { architecture?: unknown }).architecture;
  if (typeof architecture !== 'string') {
    return { ok: false, reason: L().amp.noArchitecture };
  }
  return { ok: true, architecture };
}
