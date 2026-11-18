// Messages from the Python side (the song service and the guitar engine). Python holds no text for
// people: it sends a code and its values, and the words are in the `service` namespace.
import { L } from './index';

export type MessageParams = Record<string, string | number>;

export interface ServiceMessage {
  code: string;
  params?: MessageParams;
}

export const isServiceMessage = (x: unknown): x is ServiceMessage =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as { code?: unknown }).code === 'string' &&
  ((x as { params?: unknown }).params === undefined || typeof (x as { params?: unknown }).params === 'object');

/** Words for a message, in the current language. A plain string (an older service) shows as it is. */
export function messageText(m: ServiceMessage | string | null | undefined): string {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m;
  const entry = (L().service as Record<string, unknown>)[m.code];
  if (typeof entry === 'function') return (entry as (p: MessageParams) => string)(m.params ?? {});
  if (typeof entry === 'string') return entry;
  return L().service.unknown(m.code);
}
