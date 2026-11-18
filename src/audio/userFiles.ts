// The user's own amps (.nam) and cabinets (.wav): files beside the songs (the song service's
// /api/assets, `Amps/` in the user's folder) since 2026-11-18. Until then they lived in the browser's
// IndexedDB (idb.ts), which a new port, a new window or «clear site data» lost.
//
// IndexedDB is now the outbox: what could not reach the service (it was down) waits there and goes to
// the service at the next start (`moveIdbToFiles`), as do the files of before 2026-11-18.
import type { AssetKind } from './assetFiles';
import { idbDelete, idbGet, idbGetAll, idbPut, type UserAssetRecord } from './idb';

const BASE = '/api/assets';

export interface UserAssetMeta {
  id: string;
  name: string;
  kind: AssetKind;
  addedAt: number;
}

export type UserAssetData = Pick<UserAssetRecord, 'kind' | 'data'>;

const url = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

function toBytes(data: string | ArrayBuffer): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}

async function upload(record: UserAssetRecord): Promise<boolean> {
  const params = new URLSearchParams({ name: record.name, kind: record.kind, addedAt: String(record.addedAt) });
  try {
    const response = await fetch(`${url(record.id)}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: toBytes(record.data) as BufferSource,
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function idbSafe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch {
    return fallback;
  }
}

export async function userPut(record: UserAssetRecord): Promise<void> {
  if (await upload(record)) return;
  await idbPut(record);
}

export async function userGet(id: string): Promise<UserAssetData | undefined> {
  try {
    const response = await fetch(url(id), { cache: 'no-store' });
    if (response.ok) {
      const kind: AssetKind = response.headers.get('content-type')?.includes('json') ? 'model' : 'ir';
      return { kind, data: kind === 'model' ? await response.text() : await response.arrayBuffer() };
    }
  } catch {
    // the service is down: the outbox may have it
  }
  return idbSafe(() => idbGet(id), undefined);
}

export async function userList(): Promise<UserAssetMeta[]> {
  const waiting = await idbSafe(() => idbGetAll(), [] as UserAssetRecord[]);
  let stored: UserAssetMeta[] = [];
  try {
    const response = await fetch(BASE, { cache: 'no-store' });
    if (response.ok) stored = (await response.json()) as UserAssetMeta[];
  } catch {
    // down: only what waits in the outbox
  }
  const ids = new Set(stored.map((a) => a.id));
  return [...stored, ...waiting.filter((r) => !ids.has(r.id)).map(({ id, name, kind, addedAt }) => ({ id, name, kind, addedAt }))];
}

export async function userDelete(id: string): Promise<void> {
  try {
    await fetch(url(id), { method: 'DELETE' });
  } catch {
    // down: deleted from the outbox below; a file already sent stays until the next delete
  }
  await idbSafe(() => idbDelete(id), undefined);
}

/** At start: everything waiting in IndexedDB goes to the service, and leaves IndexedDB once it is there. */
export async function moveIdbToFiles(): Promise<number> {
  const waiting = await idbSafe(() => idbGetAll(), [] as UserAssetRecord[]);
  let moved = 0;
  for (const record of waiting) {
    if (!(await upload(record))) break;
    await idbSafe(() => idbDelete(record.id), undefined);
    moved += 1;
  }
  return moved;
}
