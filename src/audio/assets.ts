// Catalog of amp models and cabinets: built-in captures of real amps and the TONE3000 demo set,
// plus the user's own files.
import { APP_NAME, L } from '../i18n';
import type { ReverbType } from '../state/presets';
import { classifyAssetFile, isWavHeader, type AssetKind } from './assetFiles';
import { userDelete, userGet, userList, userPut } from './userFiles';
import { validateNamJson } from './namMeta';

export interface AssetInfo {
  id: string;
  name: string;
  kind: AssetKind;
  builtIn: boolean;
  /** An A2 capture with a smaller sub-model («Лёгкая модель»); unknown for the user's files. */
  slimmable?: boolean;
  /** A built-in amp's own «Драйв» and «Уровень пресета» (see `BUILTIN_MODELS`). */
  drive?: number;
  level?: number;
}

export const SIMPLE_AMP = 'simple';
export const NO_CAB = 'none';

// `drive`, `level`: what an amp picked by hand in the list comes with. As captured the amps differ by
// 15 dB in loudness and more (16 Nov 2026, a real DI at −9 dBFS peak: −28 dB RMS for the 5150, −13 for
// the AC10), so picking another one made the guitar jump. With these every amp plays as loud as the
// presets (−21 dB RMS, within 0.3 dB: the fast engine's chain, the Celestion cabinet, flat EQ, no
// effects). The drive is the capture's own (0), except for the four the presets tuned.
// What each one sounds like is `t.amp.modelNotes[id]`; the shown name is `builtinName()`.
export const BUILTIN_MODELS: readonly AssetInfo[] = [
  // Captures of real amps (community collection, scripts/setup-tones.mjs), the presets' amps since 2026-11-16.
  { id: 'nam:twin', name: 'Fender Twin Reverb', kind: 'model', builtIn: true, drive: 9, level: 11 },
  { id: 'nam:jcm2000', name: 'Marshall JCM2000', kind: 'model', builtIn: true, drive: -15, level: 0 },
  { id: 'nam:jcm900', name: 'Marshall JCM900', kind: 'model', builtIn: true, drive: 0, level: 1.5 },
  { id: 'nam:shirley', name: 'Friedman Dirty Shirley', kind: 'model', builtIn: true, drive: -12, level: -8 },
  { id: 'nam:ac15', name: 'Vox AC15 Top Boost', kind: 'model', builtIn: true, drive: 0, level: 3 },
  { id: 'nam:5150', name: 'Peavey 5150', kind: 'model', builtIn: true, drive: 0, level: 7 },
  // The TONE3000 demo set (the first presets' amps).
  { id: 'nam:jc', name: 'Roland JC-120', kind: 'model', builtIn: true, slimmable: true, drive: 0, level: 5 },
  { id: 'nam:jcm', name: 'Marshall JCM800', kind: 'model', builtIn: true, slimmable: true, drive: 0, level: 0.5 },
  { id: 'nam:dumble', name: 'Dumble ODS', kind: 'model', builtIn: true, slimmable: true, drive: 0, level: -1 },
  { id: 'nam:ac10', name: 'Vox AC10', kind: 'model', builtIn: true, slimmable: true, drive: 0, level: -7.5 },
  { id: 'nam:deluxe-a2', name: 'Fender Deluxe Reverb', kind: 'model', builtIn: true, slimmable: true, drive: 0, level: -3.5 },
  { id: 'nam:5153', name: 'EVH 5153', kind: 'model', builtIn: true, slimmable: true, drive: 0, level: 0 },
  { id: SIMPLE_AMP, name: 'Simple (built-in)', kind: 'model', builtIn: true, drive: 0, level: -7 },
];

/** The drive and level a built-in amp is offered with; null for the user's own file (nothing is known of it). */
export function modelDefaults(id: string): { inputDb: number; levelDb: number } | null {
  const model = BUILTIN_MODELS.find((m) => m.id === id);
  return model?.drive !== undefined && model.level !== undefined ? { inputDb: model.drive, levelDb: model.level } : null;
}

export const BUILTIN_IRS: readonly AssetInfo[] = [
  { id: 'ir:celestion', name: 'Celestion', kind: 'ir', builtIn: true },
  { id: 'ir:mesa', name: 'Mesa', kind: 'ir', builtIn: true },
  { id: 'ir:eminence', name: 'Eminence', kind: 'ir', builtIn: true },
  { id: NO_CAB, name: 'No cabinet', kind: 'ir', builtIn: true },
];

/** The name an asset is shown with: brand names as they are, the two special ones in the interface's language. */
export function builtinName(asset: Pick<AssetInfo, 'id' | 'name'>): string {
  if (asset.id === SIMPLE_AMP) return L().amp.simpleAmp;
  if (asset.id === NO_CAB) return L().amp.noCabinet;
  return asset.name;
}

const REVERB_IR: Record<ReverbType, string> = { spring: 'ir:spring', plate: 'ir:plate' };

/** A built-in file is missing from public/ (the server answers with the app's page instead). */
const missingTones = () => L().amp.filesMissing(APP_NAME);

function builtinUrl(id: string): string | null {
  const base = import.meta.env.BASE_URL;
  if (id.startsWith('nam:')) return `${base}tones/models/${id.slice(4)}.nam`;
  if (id.startsWith('ir:')) return `${base}tones/irs/${id.slice(3)}.wav`;
  return null;
}

export function assetName(id: string, userAssets: readonly AssetInfo[]): string {
  const all = [...BUILTIN_MODELS, ...BUILTIN_IRS, ...userAssets];
  const found = all.find((a) => a.id === id);
  if (found) return builtinName(found);
  return id.startsWith('user:') ? L().amp.ownFileGone : id;
}

const modelCache = new Map<string, string>();
const irCache = new Map<string, Promise<AudioBuffer>>();

export async function loadModelJson(id: string): Promise<string> {
  const cached = modelCache.get(id);
  if (cached) return cached;
  let text: string;
  if (id.startsWith('user:')) {
    const record = await userGet(id);
    if (!record || typeof record.data !== 'string') throw new Error(L().amp.ownModelMissing);
    text = record.data;
  } else {
    const url = builtinUrl(id);
    if (!url) throw new Error(L().amp.unknownModel(id));
    const response = await fetch(url);
    text = response.ok ? await response.text() : '';
    // A missing file in public/ comes back as the app's HTML page, so check the contents.
    if (!validateNamJson(text).ok) throw new Error(missingTones());
  }
  modelCache.set(id, text);
  return text;
}

async function irBytes(id: string): Promise<ArrayBuffer> {
  if (id.startsWith('user:')) {
    const record = await userGet(id);
    if (!record || !(record.data instanceof ArrayBuffer)) throw new Error(L().amp.ownCabinetMissing);
    return record.data.slice(0); // decodeAudioData detaches its argument
  }
  const url = builtinUrl(id);
  if (!url) throw new Error(L().amp.unknownCabinet(id));
  const response = await fetch(url);
  const bytes = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
  if (!isWavHeader(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)))) throw new Error(missingTones());
  return bytes;
}

export function loadIrBuffer(ctx: BaseAudioContext, id: string): Promise<AudioBuffer> {
  const key = `${id}@${ctx.sampleRate}`;
  let pending = irCache.get(key);
  if (!pending) {
    pending = irBytes(id).then((bytes) => ctx.decodeAudioData(bytes));
    pending.catch(() => irCache.delete(key));
    irCache.set(key, pending);
  }
  return pending;
}

export function loadReverbBuffer(ctx: BaseAudioContext, type: ReverbType): Promise<AudioBuffer> {
  return loadIrBuffer(ctx, REVERB_IR[type]);
}

/**
 * A dropped file as bytes, for the native engine. A model is kept as the .nam text, so it goes out as
 * its UTF-8 bytes. Null for a built-in id and for a file that is gone.
 */
export async function loadUserAssetBytes(id: string): Promise<{ kind: AssetKind; bytes: Uint8Array } | null> {
  if (!id.startsWith('user:')) return null;
  const record = await userGet(id);
  if (!record) return null;
  const bytes = typeof record.data === 'string' ? new TextEncoder().encode(record.data) : new Uint8Array(record.data);
  return { kind: record.kind, bytes };
}

/** Validates and stores a dropped .nam / .wav file. Throws an Error with a message for the user. */
export async function addUserAsset(file: File): Promise<AssetInfo> {
  const kind = classifyAssetFile(file.name);
  if (!kind) throw new Error(L().amp.onlyNamOrWav);
  if (file.size > 30 * 1024 * 1024) throw new Error(L().amp.fileTooBig);
  const name = file.name.replace(/\.[^.]+$/, '');
  let data: string | ArrayBuffer;
  if (kind === 'model') {
    data = await file.text();
    const check = validateNamJson(data);
    if (!check.ok) throw new Error(check.reason);
  } else {
    data = await file.arrayBuffer();
    if (!isWavHeader(new Uint8Array(data, 0, Math.min(12, data.byteLength)))) {
      throw new Error(L().amp.notWav);
    }
    try {
      await new OfflineAudioContext(1, 1, 48000).decodeAudioData(data.slice(0));
    } catch {
      throw new Error(L().amp.wavUnreadable);
    }
  }
  const id = `user:${crypto.randomUUID()}`;
  await userPut({ id, name, kind, data, addedAt: Date.now() });
  return { id, name, kind, builtIn: false };
}

export async function listUserAssets(): Promise<AssetInfo[]> {
  const records = await userList();
  return records
    .sort((a, b) => a.addedAt - b.addedAt)
    .map(({ id, name, kind }) => ({ id, name, kind, builtIn: false }));
}

export async function removeUserAsset(id: string): Promise<void> {
  await userDelete(id);
  modelCache.delete(id);
  for (const key of irCache.keys()) if (key.startsWith(`${id}@`)) irCache.delete(key);
}
