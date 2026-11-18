// What the page asks the song service before its first frame: the saved settings (a file beside the
// songs since 2026-11-18, the browser keeping only a copy) and how it was started (/api/runtime: the
// Strum window, the guitar engine's port). Both wait a little for the service: in the author's copy
// `npm run dev` opens the page before the service is up.

export interface RuntimeInfo {
  /** Started by the Strum window (shell/): the sound may start without a key press. */
  shell: boolean;
  /** The guitar engine's port when the service serves the page (no Vite proxy in front of it). */
  guitarPort: number | null;
}

let runtime: RuntimeInfo = { shell: false, guitarPort: null };

export function runtimeInfo(): RuntimeInfo {
  return runtime;
}

export type Fetched = { kind: 'ok'; response: Response } | { kind: 'missing' } | { kind: 'down' };

/** A GET that tells "not there" (404) from "the service is not up" (no answer, or Vite's 503). */
export async function fetchLocal(url: string, waitMs: number, stepMs = 250): Promise<Fetched> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return { kind: 'ok', response };
      if (response.status === 404) return { kind: 'missing' };
    } catch {
      // not up yet
    }
    if (Date.now() >= until) return { kind: 'down' };
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export async function loadRuntimeInfo(waitMs: number): Promise<void> {
  const got = await fetchLocal('/api/runtime', waitMs);
  if (got.kind !== 'ok') return;
  try {
    const data = (await got.response.json()) as Partial<RuntimeInfo>;
    runtime = {
      shell: data.shell === true,
      guitarPort: typeof data.guitarPort === 'number' ? data.guitarPort : null,
    };
  } catch {
    // an older service: the defaults
  }
}

/**
 * Whether this page may start sound without a key press: the Strum window allows it (WebView2 runs
 * with no autoplay gate). Asked of a throwaway context: a start that waits for a gesture would hang.
 */
export async function soundMayStart(waitMs = 600): Promise<boolean> {
  if (typeof AudioContext === 'undefined') return false;
  const probe = new AudioContext();
  try {
    if (probe.state === 'running') return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(probe.state === 'running'), waitMs);
      probe.onstatechange = () => {
        if (probe.state !== 'running') return;
        clearTimeout(timer);
        resolve(true);
      };
    });
  } finally {
    void probe.close().catch(() => undefined);
  }
}
