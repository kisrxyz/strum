// «Быстрый»: the browser's side of one conversation with the native guitar engine.
//
// The session decides which path the guitar takes — the native engine or the browser chain — and
// keeps it right while things go wrong:
//
//   start()  → connect, hello, open, wait for `running` (5 s). Anything else: the browser path and
//              a toast.
//   native, then the socket drops or the card errors → 5 s of grace (the engine may be right
//              back), then the browser path and a toast.
//   browser, the engine answers `running` again → back to native, a toast. The link keeps knocking
//              (a try a second) and asks for the card again every few seconds while it is in error.
//
// Rebuilding the audio for a path is the host's business (the AudioEngine); the session only
// tells it when. The session also remembers the preset, channel and master volume the engine
// should have, and plays them back whenever the engine is (re)opened — a restarted engine knows
// nothing.
import { runtimeInfo } from '../../app/boot';
import type { MainsHz } from '../../dsp/mains';
import type { ChannelChoice } from '../../dsp/channel';
import type { LatencyEstimate } from '../../dsp/latency';
import { MIN_DB } from '../../dsp/level';
import { L } from '../../i18n';
import type { Preset } from '../../state/presets';
import { type NativeNote, useRuntime, type GuitarPath, type NativeRuntime } from '../../state/runtime';
import { NativeLink, type SocketFactory } from './client';
import type { EngineBuffer, EngineState, EngineStats, ToneOffsets } from './protocol';

// What the session says, in the interface's language at the moment it says it.
export const textNotStarted = (): string => L().input.asioNotStarted;
export const textLost = (): string => L().input.asioLost;

/** The words for why the guitar is not on ASIO, in the current language. */
export function nativeNoteText(note: NativeNote): string {
  return note.kind === 'notStarted' ? textNotStarted() : note.kind === 'lost' ? textLost() : note.text;
}
export const textBack = (): string => L().input.asioBack;
export const textAssetGone = (): string => L().input.ownFileGone;

/** The engine gets this long to say «running» after `open`. */
export const OPEN_TIMEOUT_MS = 5000;
/** A lost engine gets this long to come back before the guitar moves to the browser. */
export const GRACE_MS = 5000;
/** While the browser plays and the engine is in an error, the card is asked for this often. */
export const REOPEN_MS = 5000;

/** A user's own model or cabinet, as bytes for the engine. */
export interface NativeAsset {
  kind: 'model' | 'ir';
  bytes: Uint8Array;
}

/** What the AudioEngine does for the session. */
export interface SessionHost {
  /**
   * Rebuilds the audio for the path the session just chose. `state` is the running engine's state
   * for 'native' (its sample rate sets the analysis context), null for 'browser'.
   */
  switchPath(path: GuitarPath, state: EngineState | null): Promise<void>;
  /** A new `state` arrived while the native path is in use (latency, amp, device name). */
  nativeState?(state: EngineState): void;
}

export interface SessionOptions {
  host: SessionHost;
  /** The device and buffer to ask the engine for (read each time `open` is sent). */
  config: () => { device: string | null; buffer: EngineBuffer };
  /** The bytes of a `user:` file; null when it is not there. */
  loadAsset: (id: string) => Promise<NativeAsset | null>;
  /** Defaults to `ws(s)://<this page's host>/guitar`. */
  url?: string;
  createSocket?: SocketFactory;
}

/** 'starting': between `start()` and its answer. Null path = not started or stopped. */
type Phase = 'idle' | 'starting' | 'native' | 'browser';

interface Waiter {
  state(state: EngineState): void;
  closed(): void;
}

const rt = () => useRuntime.getState();

export class NativeSession {
  /** Audio frames of the engine; set by the host while it has somewhere to play them. */
  onFrame: ((frame0: number, left: Float32Array, right: Float32Array) => void) | null = null;
  /** What the card played, while recording («Запись»); the same clock as `onFrame`. */
  onOutput: ((frame0: number, left: Float32Array, right: Float32Array) => void) | null = null;
  /** «Запись» wants the output frames (sent again after the engine is opened anew). */
  private recording = false;

  private readonly link: NativeLink;
  private readonly host: SessionHost;
  private readonly config: SessionOptions['config'];
  private readonly loadAsset: SessionOptions['loadAsset'];
  private readonly url: string | undefined;

  private phase: Phase = 'idle';
  /** Bumped by `start()` and `stop()`: work begun before then is stale and must not act. */
  private generation = 0;
  /** The newest state on this connection (null: no connection). */
  private latest: EngineState | null = null;
  private latestStats: EngineStats | null = null;
  /** The sample rate the native analysis context runs at. */
  private nativeRate = 0;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private reopenTimer: ReturnType<typeof setInterval> | undefined;
  private waiter: Waiter | null = null;
  private returning = false;
  /** Path switches run one after another. */
  private tail: Promise<void> = Promise.resolve();
  /** What the engine should have; played back after each `open`. */
  private desired: {
    preset: Preset | null;
    /** «Звук как в песне»: kept apart from the preset, it changes on its own. */
    offsets: ToneOffsets | null;
    channel: ChannelChoice | null;
    master: { db: number; muted: boolean } | null;
    /** «Подстроить под мою гитару», dB (0: none). */
    trim: number;
    mains: MainsHz;
  } = { preset: null, offsets: null, channel: null, master: null, trim: 0, mains: 50 };
  /** User files already sent on this connection (a refusing engine must not start a loop). */
  private readonly served = new Set<string>();

  constructor(options: SessionOptions) {
    this.host = options.host;
    this.config = options.config;
    this.loadAsset = options.loadAsset;
    this.url = options.url;
    this.link = new NativeLink(options.createSocket);
    this.link.onState = (state) => this.handleState(state);
    this.link.onStats = (stats) => {
      this.latestStats = stats;
      this.setNative({ stats });
    };
    this.link.onFrame = (frame0, left, right) => this.onFrame?.(frame0, left, right);
    this.link.onOutput = (frame0, left, right) => this.onOutput?.(frame0, left, right);
    this.link.onNeedAsset = (id) => void this.answerAsset(id);
    this.link.onClose = () => this.handleClose();
    this.link.onReconnect = () => this.handleReconnect();
  }

  /** The path the guitar takes now; null before `start()` has answered and after `stop()`. */
  get path(): GuitarPath | null {
    return this.phase === 'native' || this.phase === 'browser' ? this.phase : null;
  }

  get state(): EngineState | null {
    return this.latest;
  }

  get stats(): EngineStats | null {
    return this.latestStats;
  }

  /**
   * Connects to the engine, asks for the card and waits for sound. Resolves with the running
   * state (the native path is chosen), or with null (the browser path is chosen; the toast is
   * shown). Never rejects. The link keeps trying in the background after a null.
   */
  async start(): Promise<EngineState | null> {
    this.reset();
    const gen = this.generation;
    this.phase = 'starting';
    this.setNative({ link: 'connecting', state: null, stats: null, note: null });
    let first: EngineState;
    try {
      first = await this.link.connect(this.url ?? guitarUrl());
    } catch {
      return this.startFailed(gen, { kind: 'notStarted' });
    }
    if (gen !== this.generation) return null;
    this.sendOpen(true);
    try {
      const running = await this.waitRunning(first);
      if (gen !== this.generation) return null;
      this.phase = 'native';
      this.nativeRate = running.sampleRate;
      this.setNative({ link: 'ready', note: null });
      return running;
    } catch (error) {
      return this.startFailed(gen, error instanceof Error ? { kind: 'text', text: error.message } : { kind: 'notStarted' });
    }
  }

  /** The user left «Быстрый» (or the engine is torn down): tells the engine and lets go of the socket. */
  stop(): void {
    if (this.phase === 'idle') return;
    this.generation++;
    this.clearTimers();
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.closed();
    this.link.send({ type: 'close' });
    this.link.close();
    this.phase = 'idle';
    this.latest = null;
    this.latestStats = null;
    this.returning = false;
    this.served.clear();
    // The trim belongs to the guitar and the card, not to a connection: it stays.
    this.desired = { preset: null, offsets: null, channel: null, master: null, trim: this.desired.trim, mains: this.desired.mains };
    this.setNative({ link: 'off', state: null, stats: null, note: null });
  }

  /** A device or buffer was chosen: asks the engine to open the card again. */
  reopen(): void {
    if (this.phase === 'native') this.sendOpen(false);
  }

  // --- what the engine should play: remembered always, sent while the native path is in use ---

  setPreset(preset: Preset, offsets: ToneOffsets | null): void {
    this.desired.preset = preset;
    this.desired.offsets = offsets;
    this.sendPreset();
  }

  /** The song's tone changed: remembered even while the browser plays, so the engine has it when it takes over. */
  setToneOffsets(offsets: ToneOffsets | null): void {
    this.desired.offsets = offsets;
    this.sendPreset();
  }

  setMaster(db: number, muted: boolean): void {
    const same = this.desired.master;
    if (same && same.db === db && same.muted === muted) return;
    this.desired.master = { db, muted };
    this.sendMaster();
  }

  /** «Запись»: ask the engine for what the card plays too, or stop. */
  setRecording(on: boolean): void {
    if (this.recording === on) return;
    this.recording = on;
    this.link.send({ type: 'record', on });
  }

  setChannel(choice: ChannelChoice): void {
    if (this.desired.channel === choice) return;
    this.desired.channel = choice;
    if (this.phase === 'native') this.link.send({ type: 'channel', choice });
  }

  /** «Подстроить под мою гитару»: the input's own gain, dB. */
  setTrim(db: number): void {
    if (this.desired.trim === db) return;
    this.desired.trim = db;
    if (this.phase === 'native') this.link.send({ type: 'trim', db });
  }

  /** The mains the hum filter notches: 50 or 60 Hz. */
  setMains(hz: MainsHz): void {
    if (this.desired.mains === hz) return;
    this.desired.mains = hz;
    if (this.phase === 'native') this.link.send({ type: 'mains', hz });
  }

  // --- the engine speaks ---

  private handleState(state: EngineState): void {
    this.latest = state;
    this.setNative({ state });
    this.waiter?.state(state);
    if (this.phase === 'native') this.nativeStateChanged(state);
    else if (this.phase === 'browser' && state.status === 'running') this.maybeReturn(state);
  }

  private nativeStateChanged(state: EngineState): void {
    this.host.nativeState?.(state);
    if (state.status !== 'running') {
      this.beginGrace(state.status === 'starting' ? 'connecting' : 'lost'); // 'starting': the card is being reopened
      return;
    }
    this.clearGrace();
    this.setNative({ link: 'ready', note: null });
    if (state.sampleRate !== this.nativeRate) {
      // The card came back at another rate: the analysis context has to follow.
      this.nativeRate = state.sampleRate;
      const gen = this.generation;
      this.enqueue(async () => {
        if (gen === this.generation && this.phase === 'native') await this.host.switchPath('native', state);
      });
    }
  }

  private handleClose(): void {
    this.latest = null;
    this.waiter?.closed();
    if (this.phase === 'native') this.beginGrace('lost');
    else if (this.phase === 'browser') this.setNative({ link: 'lost' });
  }

  /** The link got through again after a drop (or after a failed start). */
  private handleReconnect(): void {
    this.served.clear(); // an engine that restarted has none of our files
    if (this.phase === 'native' || this.phase === 'browser') this.sendOpen(true);
  }

  private async answerAsset(id: string): Promise<void> {
    if (this.served.has(id)) return;
    this.served.add(id);
    const gen = this.generation;
    let asset: NativeAsset | null = null;
    try {
      asset = await this.loadAsset(id);
    } catch {
      asset = null;
    }
    if (gen !== this.generation) return;
    if (!asset) {
      rt().showToast(textAssetGone(), 'warn');
      return;
    }
    this.link.send({ type: 'asset', id, kind: asset.kind, data: bytesToBase64(asset.bytes) });
    this.sendPreset(true); // the preset that asked for the file can go on now
  }

  // --- going wrong, and right again ---

  private startFailed(gen: number, note: NativeNote): null {
    if (gen !== this.generation) return null;
    this.phase = 'browser';
    this.setNative({ link: 'lost', note });
    rt().showToast(nativeNoteText(note), 'warn');
    this.armReopen();
    return null;
  }

  /** Waits for the engine to report `running` after our `open` (states before `open` do not count). */
  private waitRunning(first: EngineState): Promise<EngineState> {
    const want = this.config();
    if (first.status === 'running' && first.buffer === want.buffer && (want.device === null || first.device === want.device)) {
      return Promise.resolve(first); // it already plays what we asked for
    }
    return new Promise<EngineState>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        if (this.waiter === waiter) this.waiter = null;
      };
      const waiter: Waiter = {
        state: (state) => {
          if (state.status === 'running') {
            done();
            resolve(state);
          } else if (state.status === 'error') {
            done();
            reject(new Error(state.error ?? textNotStarted()));
          }
        },
        closed: () => {
          done();
          reject(new Error(textNotStarted()));
        },
      };
      const timer = setTimeout(() => {
        done();
        const last = this.latest;
        reject(new Error(last?.status === 'error' && last.error ? last.error : textNotStarted()));
      }, OPEN_TIMEOUT_MS);
      this.waiter = waiter;
    });
  }

  /** The engine is not running while it should: wait a little, then give the guitar to the browser. */
  private beginGrace(link: 'connecting' | 'lost'): void {
    this.setNative({ link });
    if (this.graceTimer) return; // the clock is already running
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      const last = this.latest;
      this.fallBack(last?.status === 'error' && last.error ? { kind: 'text', text: last.error } : { kind: 'lost' });
    }, GRACE_MS);
  }

  private clearGrace(): void {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  private fallBack(note: NativeNote): void {
    if (this.phase !== 'native') return;
    this.phase = 'browser';
    this.setNative({ link: 'lost', note });
    rt().showToast(nativeNoteText(note), 'warn');
    const gen = this.generation;
    this.enqueue(async () => {
      if (gen === this.generation) await this.host.switchPath('browser', null);
    });
    this.armReopen();
  }

  private maybeReturn(state: EngineState): void {
    if (this.returning) return;
    this.returning = true;
    const gen = this.generation;
    this.enqueue(async () => {
      try {
        if (gen !== this.generation || this.phase !== 'browser') return;
        await this.host.switchPath('native', state);
        if (gen !== this.generation) return;
        this.phase = 'native';
        this.nativeRate = state.sampleRate;
        this.disarmReopen();
        // The switch may have waited a long time behind a build (a microphone prompt): the engine
        // that asked for the guitar may have dropped since. Then it gets the grace time like any
        // engine that drops, and nobody is told it works.
        if (this.link.connected && this.latest?.status === 'running') {
          this.setNative({ link: 'ready', note: null });
          rt().showToast(textBack());
        } else {
          this.beginGrace('lost');
        }
        // The browser chain is gone: the engine may sound now. What changed while it was kept quiet goes out too.
        this.replay();
      } finally {
        this.returning = false;
      }
    });
  }

  /** While the browser plays and the card is not open, ask for it now and then. */
  private armReopen(): void {
    this.disarmReopen();
    this.reopenTimer = setInterval(() => {
      const last = this.latest;
      if (this.phase === 'browser' && this.link.connected && last && (last.status === 'error' || last.status === 'idle')) {
        this.sendOpen(true);
      }
    }, REOPEN_MS);
  }

  private disarmReopen(): void {
    clearInterval(this.reopenTimer);
    this.reopenTimer = undefined;
  }

  // --- sending ---

  private sendOpen(replay: boolean): void {
    const { device, buffer } = this.config();
    this.link.send({ type: 'open', device, buffer });
    if (replay) this.replay();
  }

  /** Everything the engine should have, after an `open` (a restarted engine knows nothing). */
  private replay(): void {
    this.sendPreset(true);
    const { channel, trim, mains } = this.desired;
    if (channel) this.link.send({ type: 'channel', choice: channel });
    this.link.send({ type: 'trim', db: trim }); // even 0: the engine may still hold an older one
    this.link.send({ type: 'mains', hz: mains });
    this.sendMaster(true);
    if (this.recording) this.link.send({ type: 'record', on: true });
  }

  /** Goes out while the native path plays; `force`: also while the engine is being opened or tried out. */
  private sendPreset(force = false): void {
    const wanted = this.desired.preset;
    if (!wanted || (!force && this.phase !== 'native')) return;
    this.link.send({ type: 'preset', preset: wanted, toneOffsets: this.desired.offsets });
  }

  private sendMaster(force = false): void {
    const master = this.desired.master;
    if (!master || (!force && this.phase !== 'native')) return;
    // While the browser plays, the engine is only being tried out: it stays quiet.
    this.link.send({ type: 'master', db: master.db, muted: master.muted || this.phase === 'browser' });
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error: unknown) => console.warn('[native] path switch failed', error));
  }

  private reset(): void {
    this.generation++;
    this.clearTimers();
    this.waiter = null;
    this.latest = null;
    this.latestStats = null;
    this.returning = false;
    this.served.clear();
  }

  private clearTimers(): void {
    this.clearGrace();
    this.disarmReopen();
  }

  private setNative(patch: Partial<NativeRuntime>): void {
    const state = rt();
    state.patch({ native: { ...state.native, ...patch } });
  }
}

/**
 * The socket address of the engine: next to the page in the author's copy (Vite proxies `/guitar`),
 * on its own port in the installed app (`/api/runtime` says which).
 */
export function guitarUrl(
  where: Pick<Location, 'protocol' | 'host' | 'hostname'> = location,
  port: number | null = runtimeInfo().guitarPort,
): string {
  if (port !== null) return `ws://${where.hostname}:${port}/guitar`;
  return `${where.protocol === 'https:' ? 'wss' : 'ws'}://${where.host}/guitar`;
}

/** Base64 of a file for the `asset` message (no `btoa` of a whole megabyte at once). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return btoa(parts.join(''));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The M-Track driver holding ≈ 10 ms more on its input: only a replug helps. */
export const textDriverStuck = (): string => L().input.driverStuck;

/** The engine reports driver latency only: the browser adds no processing of its own. */
export function nativeLatency(latencyMs: { input: number; output: number } | null): LatencyEstimate | null {
  if (!latencyMs) return null;
  const inputMs = round1(latencyMs.input);
  const outputMs = round1(latencyMs.output);
  return { inputMs, processingMs: 0, outputMs, totalMs: round1(inputMs + outputMs), inputEstimated: false };
}

/** The engine's output level; it sends −200 dB for silence, the browser path's floor is −120. */
export function outputDbFromStats(stats: EngineStats | null, kind: 'peak' | 'rms'): number {
  if (!stats) return MIN_DB;
  return Math.max(MIN_DB, kind === 'peak' ? stats.outPeakDb : stats.outRmsDb);
}
