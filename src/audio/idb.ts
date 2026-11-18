// Tiny IndexedDB store for the user's own models and cabinets.
import type { AssetKind } from './assetFiles';

export interface UserAssetRecord {
  id: string;
  name: string;
  kind: AssetKind;
  /** .nam JSON text or .wav bytes. */
  data: string | ArrayBuffer;
  addedAt: number;
}

const DB_NAME = 'kvartirnik';
const STORE = 'assets';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = op(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function idbPut(record: UserAssetRecord): Promise<void> {
  await run('readwrite', (s) => s.put(record));
}

export function idbGet(id: string): Promise<UserAssetRecord | undefined> {
  return run('readonly', (s) => s.get(id) as IDBRequest<UserAssetRecord | undefined>);
}

export function idbGetAll(): Promise<UserAssetRecord[]> {
  return run('readonly', (s) => s.getAll() as IDBRequest<UserAssetRecord[]>);
}

export async function idbDelete(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
