// The settings as a file beside the songs (`settings.json`, the song service's /api/settings).
//
// Zustand's persist keeps writing localStorage as before; this module makes the file the one that
// counts: at start the file's copy is put into localStorage and the store rehydrates from it, and
// every change is sent to the file a moment later. A browser copy without a file (the author's
// settings before 2026-11-18) is uploaded once. While the service is down the browser copy is used
// and sent as soon as the service answers.
import { fetchLocal } from '../app/boot';
import { useSettings } from './settings';

export const SETTINGS_KEY = 'kvartirnik-settings';
const URL = '/api/settings';
const SAVE_DELAY_MS = 300;
const RETRY_MS = 5000;

export type FileState = { kind: 'file'; text: string } | { kind: 'none' } | { kind: 'down' };

/** What to do at start, from the file and the browser's copy. */
export function bootPlan(file: FileState, local: string | null): { seed?: string; upload?: string } {
  if (file.kind === 'file') return file.text === local ? {} : { seed: file.text };
  if (file.kind === 'none' && local) return { upload: local };
  return {};
}

function readLocal(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

async function readFile(waitMs: number): Promise<FileState> {
  const got = await fetchLocal(URL, waitMs);
  if (got.kind === 'missing') return { kind: 'none' };
  if (got.kind === 'down') return { kind: 'down' };
  return { kind: 'file', text: await got.response.text() };
}

let timer: ReturnType<typeof setTimeout> | undefined;
let unsent = false;

async function send(text: string, keepalive = false): Promise<boolean> {
  try {
    const response = await fetch(URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: text,
      keepalive,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function save(): void {
  clearTimeout(timer);
  timer = undefined;
  const text = readLocal();
  if (!text) return;
  void send(text).then((ok) => {
    unsent = !ok;
    if (!ok) timer = setTimeout(save, RETRY_MS);
  });
}

function schedule(): void {
  unsent = true;
  clearTimeout(timer);
  timer = setTimeout(save, SAVE_DELAY_MS);
}

/** Before the first frame: the file's settings in the store, then every change goes to the file. */
export async function loadSettingsFile(waitMs: number): Promise<void> {
  const file = await readFile(waitMs);
  const plan = bootPlan(file, readLocal());
  if (plan.seed) {
    try {
      localStorage.setItem(SETTINGS_KEY, plan.seed);
      await useSettings.persist.rehydrate();
    } catch {
      // no localStorage at all: the defaults, and the next change writes the file
    }
  }
  if (plan.upload) void send(plan.upload);
  if (file.kind === 'down') {
    unsent = true;
    timer = setTimeout(save, RETRY_MS);
  }
  useSettings.subscribe(schedule);
  // Closing the window: what is still waiting goes out with the page.
  addEventListener('pagehide', () => {
    if (!unsent) return;
    const text = readLocal();
    if (text) void send(text, true);
  });
}
