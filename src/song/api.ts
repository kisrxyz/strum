// Client of the song service (service/), reached through Vite's /api proxy.
import { L } from '../i18n';
import { fileLang } from '../i18n/lang';
import { isServiceMessage, messageText } from '../i18n/messages';
import { fileNameFromDisposition } from './format';
import type { Analysis, ChordSegment, ExportBody, GuitarNote, Health, Lyrics, ModelId, PlayerSettings, Song, SongList, Stem, TabInfo, Take, Transcript } from './types';

/**
 * The tracks of a take («Запись», service/src/kv_service/takes.py): the guitar as heard, the band as
 * heard, and the card's dry input on the guitar's frames (not in the mix; for checking the input).
 */
export type TakeTrack = 'guitar' | 'band' | 'dry';

const BASE = '/api';
const offlineText = () => messageText({ code: 'offline' });

/** `message` is ready to show (current language). `offline`: the service is not running at all. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly offline: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SongPatch {
  title?: string;
  artist?: string;
  notes?: string;
  activeModel?: ModelId | null;
  player?: Partial<PlayerSettings>;
  /** The user's corrected chords; null goes back to the analysis' own. */
  chords?: ChordSegment[] | null;
  barShift?: number;
  lyrics?: Lyrics | null;
  tab?: Partial<Pick<TabInfo, 'track' | 'notation' | 'offset' | 'ratio'>>;
  guitarNotes?: Pick<GuitarNote, 'start' | 'end' | 'midi'>[] | null;
  lists?: SongList[];
}

/** The Vite proxy answers 502–504 while the service is down. */
const isProxyDown = (status: number) => status === 502 || status === 503 || status === 504;

async function errorFrom(response: Response): Promise<ServiceError> {
  if (isProxyDown(response.status)) return new ServiceError(offlineText(), true, response.status);
  let detail: unknown;
  try {
    detail = ((await response.json()) as { detail?: unknown }).detail;
  } catch {
    /* not JSON */
  }
  const message =
    typeof detail === 'string' || isServiceMessage(detail)
      ? messageText(detail)
      : messageText({ code: 'requestFailed', params: { status: response.status } });
  return new ServiceError(message, false, response.status);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(BASE + path, init);
  } catch {
    throw new ServiceError(offlineText(), true);
  }
  if (!response.ok) throw await errorFrom(response);
  return response;
}

const json = async <T>(path: string, init?: RequestInit): Promise<T> => (await call(path, init)).json() as Promise<T>;

const sendJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function addSong(
  original: File,
  mixWav: ArrayBuffer,
  onProgress?: (fraction: number) => void,
): Promise<{ song: Song; created: boolean }> {
  // XMLHttpRequest, because fetch cannot report upload progress.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('original', original, original.name);
    form.append('mix', new Blob([mixWav], { type: 'audio/wav' }), 'mix.wav');
    form.append('fileName', original.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/songs`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const response = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status === 200 || xhr.status === 201) {
        resolve(JSON.parse(xhr.responseText) as { song: Song; created: boolean });
      } else {
        void errorFrom(response).then(reject);
      }
    };
    xhr.onerror = () => reject(new ServiceError(offlineText(), true));
    xhr.send(form);
  });
}

/** What the app read from a tab file for a new tab-song (src/tab/render.worker.ts `TabSongInfo`). */
export interface TabSongMeta {
  title: string;
  artist: string;
  duration: number;
  loudnessDb: number;
  tempo: number;
  meter: number;
  track: number;
  capo: number;
  key: Analysis['key'];
}

/** A tab file as a song of its own: 201 when new, 200 with the song that already has this file. */
function addTabSong(file: File, meta: TabSongMeta): Promise<{ song: Song; created: boolean }> {
  const form = new FormData();
  form.append('tab', file, file.name);
  form.append('fileName', file.name);
  for (const field of ['title', 'artist', 'duration', 'loudnessDb', 'tempo', 'meter', 'track', 'capo'] as const) {
    form.append(field, String(meta[field]));
  }
  if (meta.key) form.append('key', JSON.stringify(meta.key));
  return json<{ song: Song; created: boolean }>('/songs/tab', { method: 'POST', body: form });
}

export const api = {
  health: () => json<Health>('/health'),
  installComponent: (part: 'songs' | 'words') => json<unknown>(`/components/${part}`, { method: 'POST' }),
  listSongs: () => json<Song[]>('/songs'),
  getSong: (id: string) => json<Song>(`/songs/${id}`),
  addSong,
  addTabSong,
  patchSong: (id: string, patch: SongPatch) => json<Song>(`/songs/${id}`, sendJson('PATCH', patch)),
  deleteSong: async (id: string) => {
    await call(`/songs/${id}`, { method: 'DELETE' });
  },
  separate: (id: string, model: ModelId) => json<Song>(`/songs/${id}/separate?model=${model}`, { method: 'POST' }),
  dropStems: (id: string, model: ModelId) => json<Song>(`/songs/${id}/stems/${model}`, { method: 'DELETE' }),
  /** `version` (the analysis' finishedAt) keeps the browser from serving an old analysis. */
  analysis: (id: string, version: string) =>
    json<Analysis>(`/songs/${id}/analysis?v=${encodeURIComponent(version)}`),
  analyze: (id: string) => json<Song>(`/songs/${id}/analyze`, { method: 'POST' }),
  peaks: async (id: string) => new Int8Array(await (await call(`/songs/${id}/peaks`)).arrayBuffer()),
  /** `version` (the transcript's finishedAt) keeps the browser from serving old words. */
  words: (id: string, version: string) => json<Transcript>(`/songs/${id}/words?v=${encodeURIComponent(version)}`),
  transcribe: (id: string) => json<Song>(`/songs/${id}/transcribe`, { method: 'POST' }),
  putTab: (id: string, name: string, data: BodyInit) =>
    json<Song>(`/songs/${id}/tab?name=${encodeURIComponent(name)}`, { method: 'PUT', body: data }),
  /** `version` (the tab's addedAt) keeps the browser from serving an old file. */
  tab: async (id: string, version: string) =>
    new Uint8Array(await (await call(`/songs/${id}/tab?v=${encodeURIComponent(version)}`)).arrayBuffer()),
  deleteTab: (id: string) => json<Song>(`/songs/${id}/tab`, { method: 'DELETE' }),
  mixUrl: (id: string) => `${BASE}/songs/${id}/mix.flac`,
  /** `version` (the stems' finishedAt) keeps the browser from serving old stems after a re-run. */
  stemUrl: (id: string, model: ModelId, stem: Stem, version: string) =>
    `${BASE}/songs/${id}/stems/${model}/${stem}.flac?v=${encodeURIComponent(version)}`,
  exportMp3: async (id: string, body: ExportBody): Promise<{ blob: Blob; fileName: string }> => {
    const response = await call(`/songs/${id}/export`, sendJson('POST', body));
    const fileName = fileNameFromDisposition(response.headers.get('Content-Disposition')) ?? `${L().actions.export.fileName}.mp3`;
    return { blob: await response.blob(), fileName };
  },

  // «Запись»
  listTakes: () => json<Take[]>('/takes'),
  createTake: (body: { songId: string | null; title: string; artist: string; path: Take['path'] }) =>
    json<Take>('/takes', sendJson('POST', body)),
  /** One chunk of a track: `at` its first frame, `perf` the moment the player lived it (performance.now()). */
  takeChunk: async (id: string, track: TakeTrack, at: number, rate: number, perf: number, data: Int16Array) => {
    const query = `track=${track}&at=${at}&rate=${rate}&perf=${perf}`;
    await call(`/takes/${id}/chunk?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data as Int16Array<ArrayBuffer>,
    });
  },
  finishTake: (id: string) => json<Take>(`/takes/${id}/finish`, { method: 'POST' }),
  patchTake: (id: string, guitarOffsetMs: number) => json<Take>(`/takes/${id}`, sendJson('PATCH', { guitarOffsetMs })),
  deleteTake: async (id: string) => {
    await call(`/takes/${id}`, { method: 'DELETE' });
  },
  /** `version` changes when the mp3 is built again (the nudge), so the player does not keep the old one. */
  takeUrl: (id: string, version: number) => `${BASE}/takes/${id}/take.mp3?v=${version}`,
  /** The language names the downloaded file. */
  takeDownloadUrl: (id: string) => `${BASE}/takes/${id}/take.mp3?download=1&lang=${fileLang()}`,
};
