// The song library as the service sees it, plus the state of the connection to the service.
import { create } from 'zustand';
import { api, ServiceError } from '../song/api';
import type { Health, Song } from '../song/types';
import { useSong } from './song';

export type ServiceState = 'checking' | 'online' | 'offline';

export interface Importing {
  name: string;
  phase: 'decode' | 'upload' | 'save';
  /** 0..1 during the upload. */
  progress: number;
}

interface LibraryData {
  service: ServiceState;
  health: Health | null;
  songs: Song[];
  importing: Importing | null;
  /** Highlighted song on the «Песни» screen. */
  selectedId: string | null;
}

export const useLibrary = create<LibraryData & { patch(p: Partial<LibraryData>): void }>()((set) => ({
  service: 'checking',
  health: null,
  songs: [],
  importing: null,
  selectedId: null,
  patch: (p) => set(p),
}));

const POLL_BUSY_MS = 1500;
const POLL_OFFLINE_MS = 5000;
/** A quiet check while nothing happens, so a crashed service is noticed. */
const POLL_IDLE_MS = 10_000;

const unfinished = (status: string | undefined) => status === 'queued' || status === 'running';

/** Something is being separated, analysed or heard: worth asking the service more often. */
export const isBusy = (songs: Song[]) =>
  songs.some(
    (s) =>
      Object.values(s.stems).some((info) => unfinished(info?.status)) ||
      unfinished(s.analysis?.status) ||
      unfinished(s.transcript?.status),
  );

/** Fetches the health and the song list; marks the service offline when it does not answer. */
export async function refreshLibrary(): Promise<void> {
  try {
    const [health, songs] = await Promise.all([api.health(), api.listSongs()]);
    const selected = useLibrary.getState().selectedId;
    useLibrary.setState({
      service: 'online',
      health,
      songs,
      selectedId: songs.some((s) => s.id === selected) ? selected : (songs[0]?.id ?? null),
    });
    const open = useSong.getState().song;
    const fresh = open && songs.find((s) => s.id === open.id);
    if (fresh) useSong.getState().syncFromLibrary(fresh);
  } catch (error) {
    if (error instanceof ServiceError && error.offline) useLibrary.setState({ service: 'offline' });
    else console.warn('[library] refresh failed', error);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

function schedule(delayMs: number): void {
  if (!polling) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), delayMs);
}

async function tick(): Promise<void> {
  timer = null;
  await refreshLibrary();
  const { service, songs, health } = useLibrary.getState();
  const downloading = health?.components
    ? health.components.songs.state === 'installing' || health.components.words.state === 'installing'
    : false;
  schedule(service === 'offline' ? POLL_OFFLINE_MS : isBusy(songs) || downloading ? POLL_BUSY_MS : POLL_IDLE_MS);
}

/** Often while songs are being separated or the service is down, rarely otherwise. */
export function startLibraryPolling(): () => void {
  polling = true;
  void tick();
  // Coming back to the window: look at once (also keeps the tests, which have no window, simple).
  const onFocus = () => pollSoon();
  globalThis.addEventListener?.('focus', onFocus);
  return () => {
    polling = false;
    globalThis.removeEventListener?.('focus', onFocus);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** After an action that starts a job (import, «Разделить»): look again shortly. */
export function pollSoon(): void {
  schedule(300);
}
