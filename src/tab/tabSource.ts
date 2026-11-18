// The main thread's side of the tab-song worker (render.worker.ts): one worker for the app,
// started on first use, requests answered by id. A crashed worker fails what it was doing and the
// next request starts a new one. The worker has no language: its failures are codes and its unnamed
// parts and sections are '', both put into words here.
import { L } from '../i18n';
import type { TabErrorCode } from './render';
import type { TabRender, TabSongInfo, TabWorkerReply, TabWorkerRequest } from './render.worker';
import TabWorker from './render.worker.ts?worker';

export type { TabRender, TabSongInfo };

type Request = TabWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (reply: TabWorkerReply) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const created = new TabWorker();
  created.onmessage = (event: MessageEvent<TabWorkerReply>) => {
    const entry = waiting.get(event.data.id);
    if (!entry) return;
    waiting.delete(event.data.id);
    entry.resolve(event.data);
  };
  created.onerror = (event) => {
    event.preventDefault();
    for (const entry of waiting.values()) entry.reject(failure('failed'));
    waiting.clear();
    created.terminate();
    if (worker === created) worker = null;
  };
  worker = created;
  return created;
}

function ask(request: Request): Promise<TabWorkerReply> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ ...request, id });
  });
}

/** The worker's failure in the current language (its own words go to the console). */
function failure(code: TabErrorCode, detail?: string): Error {
  if (detail) console.warn('[tab] worker failed:', detail);
  return new Error(L().actions.tab.errors[code] ?? L().actions.tab.errors.failed);
}

/** Names for the parts the file leaves unnamed. */
const nameParts = (names: string[]) => names.map((name, i) => name || L().actions.tab.track(i + 1));

/** Reads a dropped tab: its title, parts, length and loudness. Rejects with a message in the current language. */
export async function inspectTab(bytes: Uint8Array, ext: string): Promise<TabSongInfo> {
  const reply = await ask({ cmd: 'inspect', bytes, ext });
  if ('error' in reply) throw failure(reply.error, reply.detail);
  if (!('info' in reply)) throw failure('unreadable');
  return { ...reply.info, trackNames: nameParts(reply.info.trackNames) };
}

/** Renders a tab-song for the player: `duration` seconds at `sampleRate`, `track` as the guitar. */
export async function renderTab(bytes: Uint8Array, ext: string, track: number, sampleRate: number, duration: number): Promise<TabRender> {
  const reply = await ask({ cmd: 'render', bytes, ext, track, sampleRate, duration });
  if ('error' in reply) throw failure(reply.error, reply.detail);
  if (!('render' in reply)) throw failure('failed');
  const { render } = reply;
  // A section mark without a name in the file: «Часть 3» / "Part 3".
  const sections = render.analysis.sections.map((s, i) => (s.name ? s : { ...s, name: `${L().sections.other} ${i + 1}` }));
  return { ...render, trackNames: nameParts(render.trackNames), analysis: { ...render.analysis, sections } };
}
