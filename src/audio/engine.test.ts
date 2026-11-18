// The AudioEngine's two guitar paths against fake Web Audio, a fake WebSocket and fake timers:
// the native path never touches the microphone, everything the engine is told goes to the native
// engine, and a lost engine moves the guitar to the browser and back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket, engineState, engineStats } from './native/fakes';
import { encodeFrame, type ClientMessage } from './native/protocol';

// The settings store reads localStorage when its module loads.
vi.hoisted(() => {
  const data = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
});

vi.mock('neural-amp-modeler-wasm/engine', () => ({
  NamEngine: {
    attach: vi.fn(async () => {
      throw new Error('no wasm in tests');
    }),
  },
}));

// ---- a Web Audio that does nothing, with nodes that accept any property ----

/** A callable thing with a `value`: stands in for any AudioParam or method we do not care about. */
function loose(): any {
  const fn: any = vi.fn();
  fn.value = 0;
  return new Proxy(fn, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return (target[prop] = loose());
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function makeNode(extra: Record<string, unknown> = {}): any {
  const base: Record<string | symbol, unknown> = {
    connections: [] as unknown[],
    connect(to: unknown) {
      (base.connections as unknown[]).push(to);
      return to;
    },
    disconnect() {},
    port: { postMessage: vi.fn(), onmessage: null },
    getFloatTimeDomainData(buf: Float32Array) {
      buf.fill((base.level as number | undefined) ?? 0);
    },
    getFloatFrequencyData(buf: Float32Array) {
      buf.fill(-120);
    },
    ...extra,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return (target[prop] = loose());
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

const contexts: FakeContext[] = [];
/** While set, `addModule` of every context waits for it (a slow build the test can interleave with). */
let moduleGate: Promise<void> | null = null;
/** While set, `setSinkId` (choosing the browser's output device) waits for it. */
let sinkGate: Promise<void> | null = null;
/** The animation-frame loops that are running (a build that leaks one shows up here). */
const activeFrames = new Set<number>();
const workletNodes: any[] = [];

class FakeContext {
  sampleRate: number;
  state = 'running';
  currentTime = 0;
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = makeNode();
  audioWorklet = {
    addModule: vi.fn(async () => {
      await moduleGate;
    }),
  };
  setSinkId = vi.fn(async () => {
    await sinkGate;
  });
  analysers: any[] = [];

  constructor(readonly options: { sampleRate?: number; latencyHint?: string } = {}) {
    this.sampleRate = options.sampleRate ?? 44100;
    contexts.push(this);
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) return (target as any)[prop];
        if (typeof prop === 'string' && prop.startsWith('create')) return () => makeNode();
        return undefined;
      },
    });
  }
  async resume() {}
  async close() {
    this.state = 'closed';
  }
  createAnalyser() {
    const node = makeNode();
    this.analysers.push(node);
    return node;
  }
  async decodeAudioData() {
    return {};
  }
}

class FakeWorkletNode {
  readonly node: any;
  constructor(
    readonly ctx: unknown,
    readonly name: string,
    readonly options: unknown,
  ) {
    this.node = makeNode({ name, options });
    workletNodes.push(this.node);
    return this.node;
  }
}

const fakeTrack = () => ({ label: 'Mic', stop: vi.fn(), addEventListener: vi.fn(), getSettings: () => ({}) });
let getUserMedia: ReturnType<typeof vi.fn>;
let micTrack: ReturnType<typeof fakeTrack>;

// ---- the engine, fresh for every test ----

async function load() {
  vi.resetModules();
  const { engine } = await import('./engine');
  const { useRuntime } = await import('../state/runtime');
  const { useSettings } = await import('../state/settings');
  return { engine, useRuntime, useSettings };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const latestSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
const sent = (socket: FakeSocket, type: ClientMessage['type']) => socket.messages.filter((m) => m.type === type);
const NOT_STARTED = 'ASIO did not start. The guitar plays through system audio.';
const LOST = 'ASIO stopped. The guitar plays through system audio.';
const BACK = 'ASIO is back.';

/** Starts the engine in the native path and plays the part of a healthy kv_guitar. */
async function startNative(over: { buffer?: 64 | 128 } = {}) {
  const env = await load();
  env.useSettings.setState({ guitarEngine: 'native', nativeDevice: null, nativeBuffer: over.buffer ?? 64 });
  const started = env.engine.start();
  const socket = latestSocket();
  socket.open();
  socket.say(engineState({ status: 'idle' }));
  await flush();
  socket.say(engineState());
  await started;
  return { ...env, socket };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  contexts.length = 0;
  workletNodes.length = 0;
  moduleGate = null;
  sinkGate = null;
  activeFrames.clear();
  let frameId = 0;
  micTrack = fakeTrack();
  getUserMedia = vi.fn(async () => ({ getAudioTracks: () => [micTrack], getTracks: () => [micTrack] }));
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => {
      activeFrames.add(++frameId);
      return frameId;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => activeFrames.delete(id)));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  vi.stubGlobal('navigator', {
    userAgent: 'Windows',
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AudioEngine: the native path', () => {
  it('never opens the microphone and runs the analysis context at the engine rate', async () => {
    const { engine, useRuntime, socket } = await startNative();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.options).toMatchObject({ sampleRate: 48000, latencyHint: 'playback' });
    expect(FakeSocket.instances[0]!.url).toBe('ws://localhost:5173/guitar');

    const r = useRuntime.getState();
    expect(r.status).toBe('running');
    expect(r.guitarPath).toBe('native');
    expect(r.native.link).toBe('ready');
    expect(r.sampleRate).toBe(48000);
    expect(r.activeInputLabel).toBe('M-Track Solo and Duo ASIO');
    expect(r.latency).toMatchObject({ inputMs: 8.2, processingMs: 0, outputMs: 5, totalMs: 13.2 });
    expect(engine.guitarPath).toBe('native');
    expect(engine.running).toBe(true);
    // The stream worklet is the context's only source.
    expect(workletNodes.map((n) => n.name)).toEqual(['kv-gate', 'kv-stream']);
    expect(socket.url).toBeDefined();
  });

  it('opens the engine with the saved buffer, and hands it the preset, channel, trim and master first', async () => {
    const { useSettings, socket } = await startNative();
    const preset = useSettings.getState().presets[useSettings.getState().presetIndex];
    expect(socket.messages).toEqual([
      { type: 'hello', protocol: 1 },
      { type: 'open', device: null, buffer: 64 },
      { type: 'preset', preset, toneOffsets: null },
      { type: 'channel', choice: 'both' },
      { type: 'trim', db: 0 },
      { type: 'mains', hz: 50 },
      { type: 'master', db: 0, muted: false },
    ]);
  });

  it('sends the input trim to the engine and keeps it for the next opening', async () => {
    const { engine } = await startNative();
    engine.setInputTrim(8.5);
    expect(sent(latestSocket(), 'trim').at(-1)).toEqual({ type: 'trim', db: 8.5 });
  });

  it('sends a changed preset, the master volume, the mute and the song tone to the engine', async () => {
    const { engine, useSettings, socket } = await startNative();
    const second = useSettings.getState().presets[1]!;
    await engine.applyPreset(second);
    engine.setMasterDb(-6);
    engine.setMuted(true);
    engine.setToneOffsets({ bass: 2, mid: 0, treble: -1 });
    engine.setChannelMode('right');
    expect(socket.messages.slice(7)).toEqual([
      { type: 'preset', preset: second, toneOffsets: null },
      { type: 'master', db: -6, muted: false },
      { type: 'master', db: -6, muted: true },
      { type: 'preset', preset: second, toneOffsets: { bass: 2, mid: 0, treble: -1 } },
      { type: 'channel', choice: 'right' },
    ]);
  });

  it('picks the guitar channel from the analysers and tells the engine', async () => {
    const { engine } = await startNative();
    const [anL] = contexts[0]!.analysers;
    anL.level = 0.5; // the guitar is on the left input, the right one is silent
    const frame = vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0] as FrameRequestCallback;
    const seen: string[] = [];
    engine.onFrame((snapshot) => seen.push(snapshot.channel));
    for (let t = 0; t <= 600; t += 100) frame(t);
    expect(sent(latestSocket(), 'channel').at(-1)).toEqual({ type: 'channel', choice: 'left' });
    expect(seen.at(-1)).toBe('left');
  });

  it('feeds the stream worklet with what the engine sends', async () => {
    const { socket } = await startNative();
    const stream = workletNodes.find((n) => n.name === 'kv-stream');
    const interleaved = new Float32Array(960);
    interleaved[0] = 0.25;
    interleaved[1] = -0.5;
    socket.binary(encodeFrame(0, interleaved));
    expect(stream.port.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = stream.port.postMessage.mock.calls[0];
    expect(message.left).toHaveLength(480);
    expect(message.left[0]).toBe(0.25);
    expect(message.right[0]).toBe(-0.5);
    expect(transfer).toHaveLength(2);
  });

  it('reads the output level from the engine, never below the browser floor', async () => {
    const { engine, socket } = await startNative();
    expect(engine.readOutputDb('peak')).toBe(-120); // no stats yet
    socket.say(engineStats({ outPeakDb: -200, outRmsDb: -200 }));
    expect(engine.readOutputDb('peak')).toBe(-120);
    expect(engine.readOutputDb('rms')).toBe(-120);
    socket.say(engineStats({ outPeakDb: -9, outRmsDb: -18 }));
    expect(engine.readOutputDb('peak')).toBe(-9);
    expect(engine.readOutputDb('rms')).toBe(-18);
  });

  it('shows the engine amp state, and a fallback message once', async () => {
    const { useRuntime, useSettings, socket } = await startNative();
    expect(useRuntime.getState().amp).toEqual({ state: 'ready' });
    socket.say(engineState({ amp: { state: 'fallback', message: 'Запусти npm run setup' } }));
    socket.say(engineState({ amp: { state: 'fallback', message: 'Запусти npm run setup' } }));
    expect(useRuntime.getState().amp).toEqual({ state: 'fallback', message: 'Запусти npm run setup' });
    expect(useRuntime.getState().toast?.text).toBe('Запусти npm run setup');
    const first = useRuntime.getState().toast;
    socket.say(engineState({ amp: { state: 'fallback', message: 'Запусти npm run setup' } }));
    expect(useRuntime.getState().toast).toBe(first);
    expect(useSettings).toBeDefined();
  });

  it('shows the newest engine state after the build, not the one the start answered with', async () => {
    const { useRuntime, useSettings, engine } = await load();
    useSettings.setState({ guitarEngine: 'native', nativeDevice: null, nativeBuffer: 64 });
    let releaseModules!: () => void;
    moduleGate = new Promise<void>((resolve) => (releaseModules = resolve));
    const started = engine.start();
    const socket = latestSocket();
    socket.open();
    socket.say(engineState({ status: 'idle' }));
    await flush();
    socket.say(engineState({ amp: { state: 'loading' } })); // running; the preset was just sent
    await flush(); // the start has its answer; the build waits for the worklet modules
    socket.say(engineState({ amp: { state: 'ready' }, latencyMs: { input: 3, output: 4 }, device: 'ASIO4ALL v2' }));
    await flush();
    releaseModules();
    await started;
    const r = useRuntime.getState();
    expect(r.status).toBe('running');
    expect(r.amp).toEqual({ state: 'ready' });
    expect(r.latency?.totalMs).toBe(7);
    expect(r.activeInputLabel).toBe('ASIO4ALL v2');
  });

  it('tells the engine to close when the engine is stopped', async () => {
    const { engine, useRuntime, socket } = await startNative();
    await engine.stop();
    expect(socket.messages.at(-1)).toEqual({ type: 'close' });
    expect(socket.closed).toBe(true);
    expect(useRuntime.getState().status).toBe('idle');
    expect(useRuntime.getState().guitarPath).toBeNull();
    expect(useRuntime.getState().native.link).toBe('off');
    expect(contexts[0]!.state).toBe('closed');
  });

  it('asks the engine for the new device and buffer', async () => {
    const { engine, useSettings, socket } = await startNative();
    useSettings.setState({ nativeDevice: 'ASIO4ALL v2', nativeBuffer: 128 });
    engine.reopenNative();
    expect(socket.messages.at(-1)).toEqual({ type: 'open', device: 'ASIO4ALL v2', buffer: 128 });
  });
});

describe('AudioEngine: the browser mode', () => {
  it('never connects to the native engine', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'browser' });
    await engine.start();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(useRuntime.getState().guitarPath).toBe('browser');
    expect(useRuntime.getState().native.link).toBe('off');
    expect(contexts[0]!.options).toEqual({ latencyHint: 'interactive' }); // the device's own rate, as before
    expect(engine.readOutputDb()).toBe(-120); // the (silent) fake chain
  });
});

describe('AudioEngine: from native to the browser and back', () => {
  it('starts in the browser, with a toast, when the engine is not there', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'native' });
    const toasts: string[] = [];
    useRuntime.subscribe((r, prev) => {
      if (r.toast && r.toast !== prev.toast) toasts.push(r.toast.text);
    });
    const started = engine.start();
    latestSocket().drop(); // nothing listens on the port
    await started;
    expect(toasts[0]).toBe(NOT_STARTED); // (the browser chain's own toasts about missing tones may follow)
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(useRuntime.getState()).toMatchObject({ status: 'running', guitarPath: 'browser' });
    expect(useRuntime.getState().native).toMatchObject({ link: 'lost', note: { kind: 'notStarted' } });
  });

  it('falls back to the browser 5 s after the engine drops, and returns when it is back', async () => {
    const { engine, useRuntime, socket } = await startNative();
    const toasts: string[] = [];
    useRuntime.subscribe((r, prev) => {
      if (r.toast && r.toast !== prev.toast) toasts.push(r.toast.text);
    });

    socket.drop();
    await vi.advanceTimersByTimeAsync(4900);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(engine.guitarPath).toBe('native');
    await vi.advanceTimersByTimeAsync(100);
    expect(toasts).toContain(LOST);
    expect(getUserMedia).toHaveBeenCalledTimes(1); // the microphone opens now
    expect(engine.guitarPath).toBe('browser');
    expect(useRuntime.getState()).toMatchObject({ status: 'running', guitarPath: 'browser' });
    expect(contexts[0]!.state).toBe('closed');
    expect(contexts[1]!.options).toEqual({ latencyHint: 'interactive' });
    // «Звук как в песне» turns on while the browser plays: the engine must hear of it when it is back.
    engine.setToneOffsets({ bass: 2, mid: 0, treble: -1 });

    // The engine is back (the link was knocking all the while).
    const back = latestSocket();
    back.open();
    back.say(engineState({ status: 'idle' }));
    await flush();
    expect(sent(back, 'open')).toHaveLength(1);
    expect(sent(back, 'master').at(-1)).toMatchObject({ muted: true }); // tried out quietly first
    back.say(engineState());
    await flush();
    await flush();

    expect(toasts).toContain(BACK);
    expect(engine.guitarPath).toBe('native');
    expect(useRuntime.getState()).toMatchObject({ status: 'running', guitarPath: 'native' });
    expect(micTrack.stop).toHaveBeenCalled(); // the microphone is let go again
    expect(contexts[1]!.state).toBe('closed');
    expect(contexts[2]!.options).toMatchObject({ sampleRate: 48000, latencyHint: 'playback' });
    expect(sent(back, 'master').at(-1)).toMatchObject({ muted: false });
    expect(sent(back, 'preset').at(-1)).toMatchObject({ toneOffsets: { bass: 2, mid: 0, treble: -1 } });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(activeFrames.size).toBe(1); // one loop, the native one
  });

  it('lets the first browser build finish before the returning engine takes over', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'native' });
    let release!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const started = engine.start();
    latestSocket().drop(); // the engine is still booting
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(1); // the browser path waits for the microphone prompt

    // The engine comes up meanwhile and asks for the guitar back.
    await vi.advanceTimersByTimeAsync(1000);
    const back = latestSocket();
    back.open();
    back.say(engineState({ status: 'idle' }));
    await flush();
    back.say(engineState());
    await flush();
    // Nothing is torn down under the build, nothing half-built is shown.
    expect(contexts).toHaveLength(1);
    expect(engine.running).toBe(false);
    expect(useRuntime.getState().status).toBe('starting');

    release({ getAudioTracks: () => [micTrack], getTracks: () => [micTrack] });
    await started;
    for (let i = 0; i < 8; i++) await flush();
    expect(useRuntime.getState()).toMatchObject({ status: 'running', guitarPath: 'native' });
    expect(engine.guitarPath).toBe('native');
    expect(micTrack.stop).toHaveBeenCalled(); // the microphone is let go again
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(contexts.map((c) => c.state)).toEqual(['closed', 'running']);
    expect(contexts[1]!.options).toMatchObject({ sampleRate: 48000, latencyHint: 'playback' });
    expect(activeFrames.size).toBe(1);
    expect(sent(back, 'master').at(-1)).toMatchObject({ muted: false });
  });

  it('falls back again when the engine drops while its return waits for the microphone prompt', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'native' });
    const toasts: string[] = [];
    useRuntime.subscribe((r, prev) => {
      if (r.toast && r.toast !== prev.toast) toasts.push(r.toast.text);
    });
    let release!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const started = engine.start();
    latestSocket().drop(); // the engine is still booting
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    const back = latestSocket();
    back.open();
    back.say(engineState({ status: 'idle' }));
    await flush();
    back.say(engineState());
    await flush(); // the return is queued behind the open microphone prompt
    back.drop(); // and the engine dies

    release({ getAudioTracks: () => [micTrack], getTracks: () => [micTrack] });
    await started;
    for (let i = 0; i < 8; i++) await flush();
    expect(toasts).not.toContain(BACK);
    expect(engine.guitarPath).toBe('native'); // the switch was made; the engine gets the grace time
    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 8; i++) await flush();
    expect(toasts).toContain(LOST);
    expect(engine.guitarPath).toBe('browser');
    expect(useRuntime.getState()).toMatchObject({ status: 'running', guitarPath: 'browser' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(activeFrames.size).toBe(1);
  });

  it('a stop during the choice of the output device leaves nothing running', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'browser', outputDeviceId: 'out-1' });
    let releaseSink!: () => void;
    sinkGate = new Promise<void>((resolve) => (releaseSink = resolve));
    const started = engine.start();
    for (let i = 0; i < 6; i++) await flush();
    expect(contexts[0]!.setSinkId).toHaveBeenCalled(); // the build is inside that await, already committed
    await engine.stop();
    releaseSink();
    await started;
    for (let i = 0; i < 4; i++) await flush();
    expect(useRuntime.getState().status).toBe('idle');
    expect(engine.running).toBe(false);
    expect(activeFrames.size).toBe(0);
    expect(navigator.mediaDevices.addEventListener).not.toHaveBeenCalled();
  });

  it('a build that is stopped halfway lets go of what it made and touches nothing', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'browser' });
    let release!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const started = engine.start();
    await flush();
    await engine.stop();
    release({ getAudioTracks: () => [micTrack], getTracks: () => [micTrack] });
    await started;
    for (let i = 0; i < 4; i++) await flush();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(contexts[0]!.state).toBe('closed');
    expect(engine.running).toBe(false);
    expect(engine.guitarPath).toBeNull();
    expect(useRuntime.getState().status).toBe('idle');
    expect(activeFrames.size).toBe(0);
  });

  it('restarts cleanly when the first start was overtaken while it waited for the microphone', async () => {
    const { engine, useRuntime, useSettings } = await load();
    useSettings.setState({ guitarEngine: 'browser' });
    const secondTrack = fakeTrack();
    let release!: (stream: unknown) => void;
    getUserMedia
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockImplementationOnce(async () => ({ getAudioTracks: () => [secondTrack], getTracks: () => [secondTrack] }));
    const first = engine.start();
    await flush();
    const restarted = engine.restart(); // e.g. the author switched the engine on «Вход»
    release({ getAudioTracks: () => [micTrack], getTracks: () => [micTrack] });
    await Promise.all([first, restarted]);
    expect(useRuntime.getState().status).toBe('running');
    expect(engine.guitarPath).toBe('browser');
    expect(micTrack.stop).toHaveBeenCalled(); // the overtaken build let go of its microphone
    expect(secondTrack.stop).not.toHaveBeenCalled();
    expect(contexts.map((c) => c.state)).toEqual(['closed', 'running']);
    expect(activeFrames.size).toBe(1);
  });

  it('shows the permission error when the browser path cannot open the microphone either', async () => {
    const { engine, useRuntime, socket } = await startNative();
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(useRuntime.getState().status).toBe('error');
    expect(useRuntime.getState().error?.kind).toBe('permission');
    expect(engine.running).toBe(false);
    expect(useRuntime.getState().native.link).toBe('off'); // the session is let go: «Попробовать снова» starts afresh
  });

  it('leaves «Быстрый» for good when the setting turns to the browser', async () => {
    const { engine, useSettings, socket } = await startNative();
    useSettings.setState({ guitarEngine: 'browser' });
    await engine.restart();
    expect(socket.messages.at(-1)).toEqual({ type: 'close' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(engine.guitarPath).toBe('browser');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances).toHaveLength(1); // no more knocking
  });
});
