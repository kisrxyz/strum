import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRESETS } from '../../state/presets';
import { useRuntime } from '../../state/runtime';
import { NativeLink } from './client';
import { FakeSocket, engineState, engineStats } from './fakes';
import { encodeFrame } from './protocol';
import {
  NativeSession,
  bytesToBase64,
  guitarUrl,
  nativeLatency,
  outputDbFromStats,
  type NativeAsset,
  type SessionHost,
} from './session';

const URL = 'ws://test/guitar';

const state = engineState;
const stats = engineStats;

const sent = (socket: FakeSocket, type: string) => socket.messages.filter((m) => m.type === type);
const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
const flush = () => vi.advanceTimersByTimeAsync(0);
const rt = () => useRuntime.getState();
const NOT_STARTED = 'ASIO did not start. The guitar plays through system audio.';
const LOST = 'ASIO stopped. The guitar plays through system audio.';
const BACK = 'ASIO is back.';

const CONFIG = { device: 'M-Track Solo and Duo ASIO', buffer: 64 as const };
const preset = DEFAULT_PRESETS[0]!;

function rig(config: { device: string | null; buffer: 32 | 64 | 128 | 256 } = CONFIG) {
  const host = {
    switchPath: vi.fn<SessionHost['switchPath']>(async () => undefined),
    nativeState: vi.fn<NonNullable<SessionHost['nativeState']>>(),
  };
  const loadAsset = vi.fn<(id: string) => Promise<NativeAsset | null>>(async () => null);
  const session = new NativeSession({
    host,
    config: () => config,
    createSocket: (url) => new FakeSocket(url),
    loadAsset,
    url: URL,
  });
  return { host, session, loadAsset };
}

/** Starts a session and walks it to a running engine; returns the socket. */
async function startNative(r: ReturnType<typeof rig>): Promise<FakeSocket> {
  const started = r.session.start();
  const socket = latest();
  socket.open();
  socket.say(state({ status: 'idle' }));
  await flush();
  socket.say(state());
  expect(await started).not.toBeNull();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  rt().patch({ toast: null, guitarPath: null, native: { link: 'off', state: null, stats: null, note: null } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NativeLink', () => {
  it('sends hello as soon as the socket opens and resolves with the first state', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const connected = link.connect(URL);
    const socket = latest();
    expect(socket.url).toBe(URL);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.sent).toEqual([]); // not before the socket is open
    socket.open();
    expect(socket.messages).toEqual([{ type: 'hello', protocol: 1 }]);
    socket.say(state());
    await expect(connected).resolves.toMatchObject({ type: 'state', status: 'running', sampleRate: 48000 });
    link.close();
  });

  it('decodes binary frames to onFrame', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const frames: { frame0: number; left: number[]; right: number[] }[] = [];
    link.onFrame = (frame0, left, right) => frames.push({ frame0, left: Array.from(left), right: Array.from(right) });
    const connected = link.connect(URL);
    const socket = latest();
    socket.open();
    socket.say(state());
    await connected;

    const outputs: number[] = [];
    link.onOutput = (frame0) => outputs.push(frame0);
    socket.binary(encodeFrame(96000, Float32Array.of(0.5, 1, -0.25, 0, 0, -1)));
    expect(frames).toEqual([{ frame0: 96000, left: [0.5, -0.25, 0], right: [1, 0, -1] }]);
    socket.binary(encodeFrame(96000, Float32Array.of(0.5, 1, -0.25, 0, 0, -1), 'output'));
    expect(frames).toHaveLength(1);
    expect(outputs).toEqual([96000]);

    socket.binary(new ArrayBuffer(5)); // damaged: dropped, not thrown
    socket.onmessage?.({ data: 'not json' });
    socket.say({ type: 'who-knows' });
    expect(frames).toHaveLength(1);
    link.close();
  });

  it('passes stats and need-asset on', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const got: unknown[] = [];
    link.onStats = (s) => got.push(s);
    link.onNeedAsset = (id) => got.push(id);
    const connected = link.connect(URL);
    latest().open();
    latest().say(state());
    await connected;
    latest().say(stats({ xruns: 3 }));
    latest().say({ type: 'need-asset', id: 'user:abc' });
    expect(got).toEqual([stats({ xruns: 3 }), 'user:abc']);
    link.close();
  });

  it('gives up on a silent engine after 2.5 s and keeps trying every second', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const outcome = link.connect(URL).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    latest().open(); // the socket is up but nobody answers hello
    await vi.advanceTimersByTimeAsync(2499);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).not.toBe('resolved');
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2); // the next try, one second later
    link.close();
  });

  it('rejects at once when the socket is refused, then retries every second until close()', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const outcome = link.connect(URL).then(
      () => 'resolved',
      () => 'rejected',
    );
    latest().drop(); // connection refused
    expect(await outcome).toBe('rejected');
    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances).toHaveLength(i);
      latest().drop();
    }
    link.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('tells about a drop once, then reconnects and tells about the new first state', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const events: string[] = [];
    link.onClose = () => events.push('close');
    link.onReconnect = (s) => events.push(`reconnect:${s.status}`);
    const connected = link.connect(URL);
    latest().open();
    latest().say(state());
    await connected;
    expect(events).toEqual([]); // the first connection is not a «reconnect»

    latest().drop();
    expect(events).toEqual(['close']);
    expect(link.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    latest().drop(); // a failed try is silent
    await vi.advanceTimersByTimeAsync(1000);
    latest().open();
    latest().say(state({ status: 'idle' }));
    expect(events).toEqual(['close', 'reconnect:idle']);
    expect(link.connected).toBe(true);
    link.close();
  });

  it('does not send into a socket that is not open, and close() ends it all quietly', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const closes = vi.fn();
    link.onClose = closes;
    expect(link.send({ type: 'close' })).toBe(false); // nothing connected yet
    const connected = link.connect(URL);
    expect(link.send({ type: 'close' })).toBe(false); // connecting
    latest().open();
    latest().say(state());
    await connected;
    expect(link.send({ type: 'master', db: -3, muted: false })).toBe(true);
    expect(latest().messages.at(-1)).toEqual({ type: 'master', db: -3, muted: false });
    link.close();
    expect(latest().closed).toBe(true);
    expect(link.send({ type: 'close' })).toBe(false);
    latest().onclose?.(); // a late close event of the socket we closed ourselves is not a drop
    expect(closes).not.toHaveBeenCalled();
  });

  it('ignores what an abandoned socket still says', async () => {
    const link = new NativeLink((url) => new FakeSocket(url));
    const states = vi.fn();
    link.onState = states;
    const first = link.connect(URL).catch(() => undefined);
    const old = latest();
    old.open();
    await vi.advanceTimersByTimeAsync(2500); // it times out
    await first;
    old.say(state()); // too late
    expect(states).not.toHaveBeenCalled();
    link.close();
  });
});

describe('NativeSession: start', () => {
  it('sends hello then open with the saved device and buffer', async () => {
    const r = rig({ device: 'ASIO4ALL v2', buffer: 256 });
    const started = r.session.start();
    const socket = latest();
    expect(rt().native.link).toBe('connecting');
    socket.open();
    socket.say(state({ status: 'idle', device: null, buffer: 0 }));
    await flush();
    expect(socket.messages.slice(0, 2)).toEqual([
      { type: 'hello', protocol: 1 },
      { type: 'open', device: 'ASIO4ALL v2', buffer: 256 },
    ]);
    socket.say(state({ status: 'starting' }));
    socket.say(state({ device: 'ASIO4ALL v2', buffer: 256 }));
    const running = await started;
    expect(running).toMatchObject({ status: 'running', buffer: 256 });
    expect(rt().native.link).toBe('ready');
    expect(r.session.path).toBe('native');
  });

  it('sends null as the device when the choice is «Автоматически»', async () => {
    const r = rig({ device: null, buffer: 128 });
    await startNative(r);
    expect(latest().messages[1]).toEqual({ type: 'open', device: null, buffer: 128 });
  });

  it('does not wait when the engine already runs with what we asked for', async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    latest().say(state()); // running, the same device and buffer
    expect(await started).toMatchObject({ status: 'running' });
    // The trim goes out even at 0: the engine may still hold another tab's.
    expect(latest().types).toEqual(['hello', 'open', 'trim', 'mains']);
  });

  it('plays the saved preset, channel and master into the engine right after open', async () => {
    const r = rig();
    r.session.setPreset(preset, { bass: 1, mid: 0, treble: -2 });
    r.session.setMaster(-3, false);
    r.session.setChannel('right');
    const socket = await startNative(r);
    expect(socket.messages.slice(1)).toEqual([
      { type: 'open', device: CONFIG.device, buffer: 64 },
      { type: 'preset', preset, toneOffsets: { bass: 1, mid: 0, treble: -2 } },
      { type: 'channel', choice: 'right' },
      { type: 'trim', db: 0 },
      { type: 'mains', hz: 50 },
      { type: 'master', db: -3, muted: false },
    ]);
  });

  it('falls back with a toast when the engine does not answer in 2.5 s', async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await started).toBeNull();
    expect(rt().toast?.text).toBe(NOT_STARTED);
    expect(rt().native.link).toBe('lost');
    expect(rt().native.note).toEqual({ kind: 'notStarted' });
    expect(r.session.path).toBe('browser');
  });

  it("falls back with the engine's own text when it cannot open the card", async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    latest().say(state({ status: 'idle' }));
    await flush();
    const text = 'Карта не открылась на 48 000 Гц. Поставь 48 000 в панели M-Audio и в Windows (mmsys.cpl).';
    latest().say(state({ status: 'error', error: text }));
    expect(await started).toBeNull();
    expect(rt().toast?.text).toBe(text);
    expect(rt().native.note).toEqual({ kind: 'text', text });
  });

  it('falls back when the engine says «running» too slowly (5 s)', async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    latest().say(state({ status: 'idle' }));
    await flush();
    latest().say(state({ status: 'starting' }));
    await vi.advanceTimersByTimeAsync(4999);
    latest().say(state({ status: 'starting' })); // still working: does not move the deadline
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toBeNull();
    expect(rt().toast?.text).toBe(NOT_STARTED);
  });

  it('falls back at once when the socket closes while it waits for the card', async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    latest().say(state({ status: 'idle' }));
    await flush();
    latest().drop();
    expect(await started).toBeNull();
    expect(rt().toast?.text).toBe(NOT_STARTED);
  });

  it('keeps the latest state and stats in the runtime store', async () => {
    const r = rig();
    const socket = await startNative(r);
    expect(rt().native.state).toMatchObject({ status: 'running', device: 'M-Track Solo and Duo ASIO' });
    socket.say(stats({ xruns: 2, outPeakDb: -6 }));
    expect(rt().native.stats).toMatchObject({ xruns: 2, outPeakDb: -6 });
    expect(r.session.stats?.xruns).toBe(2);
    const changed = state({ latencyMs: { input: 7, output: 4 } });
    socket.say(changed);
    expect(r.host.nativeState).toHaveBeenLastCalledWith(changed);
    expect(rt().native.state).toEqual(changed);
  });

  it('hands audio frames to the engine', async () => {
    const r = rig();
    const frames: number[] = [];
    r.session.onFrame = (frame0) => frames.push(frame0);
    const socket = await startNative(r);
    socket.binary(encodeFrame(480, new Float32Array(960)));
    socket.binary(encodeFrame(960, new Float32Array(960)));
    expect(frames).toEqual([480, 960]);
  });
});

describe('NativeSession: sending', () => {
  it('sends preset, master and channel at once while native is running', async () => {
    const r = rig();
    const socket = await startNative(r);
    const before = socket.sent.length;
    r.session.setPreset(preset, null);
    r.session.setMaster(-6, true);
    r.session.setChannel('left');
    expect(socket.messages.slice(before)).toEqual([
      { type: 'preset', preset, toneOffsets: null },
      { type: 'master', db: -6, muted: true },
      { type: 'channel', choice: 'left' },
    ]);
  });

  it('reopens the card with the new device and buffer', async () => {
    const config = { device: 'M-Track Solo and Duo ASIO' as string | null, buffer: 64 as 32 | 64 | 128 | 256 };
    const r = rig(config);
    const socket = await startNative(r);
    config.buffer = 128;
    config.device = null;
    r.session.reopen();
    expect(socket.messages.at(-1)).toEqual({ type: 'open', device: null, buffer: 128 });
  });

  it('answers need-asset with the asset bytes, then sends the preset again', async () => {
    const r = rig();
    r.loadAsset.mockResolvedValue({ kind: 'model', bytes: new TextEncoder().encode('{"version":"0.5.4"}') });
    const socket = await startNative(r);
    r.session.setPreset(preset, { bass: 2, mid: 0, treble: 0 });
    const before = socket.sent.length;

    socket.say({ type: 'need-asset', id: 'user:abc' });
    await flush();

    expect(r.loadAsset).toHaveBeenCalledWith('user:abc');
    expect(socket.messages.slice(before)).toEqual([
      { type: 'asset', id: 'user:abc', kind: 'model', data: btoa('{"version":"0.5.4"}') },
      { type: 'preset', preset, toneOffsets: { bass: 2, mid: 0, treble: 0 } },
    ]);
  });

  it('sends an impulse response as bytes too', async () => {
    const r = rig();
    r.loadAsset.mockResolvedValue({ kind: 'ir', bytes: Uint8Array.of(82, 73, 70, 70, 255, 0) });
    const socket = await startNative(r);
    socket.say({ type: 'need-asset', id: 'user:cab' });
    await flush();
    expect(socket.messages.find((m) => m.type === 'asset')).toEqual({
      type: 'asset',
      id: 'user:cab',
      kind: 'ir',
      data: 'UklGRv8A',
    });
  });

  it('answers a file only once per connection, so a refusing engine cannot start a loop', async () => {
    const r = rig();
    r.loadAsset.mockResolvedValue({ kind: 'model', bytes: Uint8Array.of(1, 2, 3) });
    const socket = await startNative(r);
    socket.say({ type: 'need-asset', id: 'user:abc' });
    await flush();
    socket.say({ type: 'need-asset', id: 'user:abc' });
    await flush();
    expect(socket.messages.filter((m) => m.type === 'asset')).toHaveLength(1);
  });

  it('says so when the file is no longer in the browser', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.say({ type: 'need-asset', id: 'user:gone' });
    await flush();
    expect(socket.messages.some((m) => m.type === 'asset')).toBe(false);
    expect(rt().toast?.text).toBe('Your amp file is missing. Drop it into the window again.');
  });
});

describe('NativeSession: the engine drops out', () => {
  it('falls back when the socket drops', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.drop();
    expect(rt().native.link).toBe('lost');
    expect(r.session.path).toBe('native'); // still waiting: the engine may be right back

    await vi.advanceTimersByTimeAsync(4900);
    expect(r.host.switchPath).not.toHaveBeenCalled();
    expect(rt().toast).toBeNull();

    await vi.advanceTimersByTimeAsync(100);
    expect(r.host.switchPath).toHaveBeenCalledTimes(1);
    expect(r.host.switchPath).toHaveBeenCalledWith('browser', null);
    expect(rt().toast?.text).toBe(LOST);
    expect(rt().native.note).toEqual({ kind: 'lost' });
    expect(r.session.path).toBe('browser');
    expect(FakeSocket.instances.length).toBeGreaterThan(2); // it kept knocking
  });

  it('stays native when the socket is back within the grace time', async () => {
    const r = rig();
    r.session.setPreset(preset, null);
    r.session.setMaster(-3, false);
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' })); // the engine restarted
    await flush();
    // A new engine knows nothing: open and everything it had is sent again.
    expect(back.types).toEqual(['hello', 'open', 'preset', 'trim', 'mains', 'master']);
    expect(back.messages[5]).toEqual({ type: 'master', db: -3, muted: false });
    back.say(state());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.host.switchPath).not.toHaveBeenCalled();
    expect(rt().native.link).toBe('ready');
    expect(rt().toast).toBeNull();
  });

  it('rebuilds the analysis context when the engine comes back at another rate', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    latest().open();
    latest().say(state({ status: 'idle' }));
    await flush();
    latest().say(state({ sampleRate: 44100 }));
    await flush();
    expect(r.host.switchPath).toHaveBeenCalledWith('native', expect.objectContaining({ sampleRate: 44100 }));
  });

  it('falls back with the engine text when the card goes away and stays away', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.say(state({ status: 'error', error: 'Карта пропала — проверь USB.' }));
    await vi.advanceTimersByTimeAsync(4900);
    expect(r.host.switchPath).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.host.switchPath).toHaveBeenCalledWith('browser', null);
    expect(rt().toast?.text).toBe('Карта пропала — проверь USB.');
  });

  it('forgives a card that reopens in time (a new buffer size)', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.say(state({ status: 'starting' }));
    expect(rt().native.link).toBe('connecting'); // the card is being reopened: not «lost»
    await vi.advanceTimersByTimeAsync(2000);
    socket.say(state({ buffer: 128 }));
    expect(rt().native.link).toBe('ready');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.host.switchPath).not.toHaveBeenCalled();
    expect(rt().toast).toBeNull();
  });

  it('returns to native when the engine is back', async () => {
    const r = rig();
    r.session.setPreset(preset, null);
    r.session.setMaster(-3, false);
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.session.path).toBe('browser');
    expect(r.host.switchPath).toHaveBeenCalledTimes(1);

    // The engine is back: the knock that is under way gets through.
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    // While the browser still plays, the engine is opened but kept quiet.
    expect(back.types.slice(0, 2)).toEqual(['hello', 'open']);
    expect(back.messages.find((m) => m.type === 'master')).toEqual({ type: 'master', db: -3, muted: true });
    expect(r.host.switchPath).toHaveBeenCalledTimes(1);

    back.say(state());
    await flush();
    expect(r.host.switchPath).toHaveBeenCalledTimes(2);
    expect(r.host.switchPath).toHaveBeenLastCalledWith('native', expect.objectContaining({ status: 'running' }));
    expect(rt().toast?.text).toBe(BACK);
    expect(rt().toast?.tone).toBe('info');
    expect(rt().native.link).toBe('ready');
    expect(rt().native.note).toBeNull();
    expect(r.session.path).toBe('native');
    // Now it is the only sound: the real master goes out.
    expect(back.messages.at(-1)).toEqual({ type: 'master', db: -3, muted: false });

    // …and only once.
    back.say(state());
    await flush();
    expect(r.host.switchPath).toHaveBeenCalledTimes(2);
  });

  it('gives the engine the grace time when it drops while the return waits for the browser build', async () => {
    const r = rig();
    const toasts: string[] = [];
    useRuntime.subscribe((s, prev) => {
      if (s.toast && s.toast !== prev.toast) toasts.push(s.toast.text);
    });
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.session.path).toBe('browser');

    // The engine is back and the guitar is asked to return, but the switch is held up (a microphone prompt).
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    let finishSwitch!: () => void;
    r.host.switchPath.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSwitch = resolve)));
    back.say(state());
    await flush();
    back.drop(); // the engine drops while it waits
    finishSwitch();
    await flush();

    expect(toasts).toEqual([LOST]); // no «снова работает» for an engine that is not there
    expect(rt().native.link).toBe('lost');
    await vi.advanceTimersByTimeAsync(4900);
    expect(r.host.switchPath).toHaveBeenCalledTimes(2); // browser, native
    await vi.advanceTimersByTimeAsync(100);
    expect(r.host.switchPath).toHaveBeenCalledTimes(3);
    expect(r.host.switchPath).toHaveBeenLastCalledWith('browser', null);
    expect(toasts).toEqual([LOST, LOST]);
    expect(r.session.path).toBe('browser');
  });

  it('says «снова работает» only for an engine that is still running when the switch is done', async () => {
    const r = rig();
    const toasts: string[] = [];
    useRuntime.subscribe((s, prev) => {
      if (s.toast && s.toast !== prev.toast) toasts.push(s.toast.text);
    });
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    let finishSwitch!: () => void;
    r.host.switchPath.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSwitch = resolve)));
    back.say(state());
    await flush();
    back.say(state({ status: 'error', error: 'Карта пропала — проверь USB.' })); // the card goes while it waits
    finishSwitch();
    await flush();
    expect(toasts).toEqual([LOST]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(toasts).toEqual([LOST, 'Карта пропала — проверь USB.']);
    expect(r.host.switchPath).toHaveBeenLastCalledWith('browser', null);
  });

  it('keeps quiet when the engine that came back is still running at the end of the switch', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    back.say(state());
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.host.switchPath).toHaveBeenCalledTimes(2); // browser, then native, and that is that
    expect(rt().native.link).toBe('ready');
    expect(rt().toast?.text).toBe(BACK);
  });

  it('returns to native after a failed start when the engine appears later', async () => {
    const r = rig();
    const started = r.session.start();
    latest().drop(); // nothing listens on the port yet
    expect(await started).toBeNull();
    expect(rt().toast?.text).toBe(NOT_STARTED);

    await vi.advanceTimersByTimeAsync(1000);
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    expect(back.types).toEqual(['hello', 'open', 'trim', 'mains']);
    back.say(state());
    await flush();
    expect(r.host.switchPath).toHaveBeenCalledWith('native', expect.objectContaining({ status: 'running' }));
    expect(rt().toast?.text).toBe(BACK);
  });

  it('asks the engine to open the card again now and then while it is in an error', async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    latest().say(state({ status: 'idle' }));
    await flush();
    latest().say(state({ status: 'error', error: 'Карта занята другой программой.' }));
    expect(await started).toBeNull();
    const socket = latest();
    const opens = () => socket.types.filter((t) => t === 'open').length;
    expect(opens()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(opens()).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(opens()).toBe(3);

    socket.say(state()); // the other program let go
    await flush();
    expect(r.host.switchPath).toHaveBeenCalledWith('native', expect.objectContaining({ status: 'running' }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(opens()).toBe(3); // enough knocking
  });

  it('sends what changed while the browser played when the engine takes over again', async () => {
    const r = rig();
    r.session.setMaster(-3, false);
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    // The engine is tried out quietly; meanwhile the guitarist moves to the other input…
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    r.host.switchPath.mockImplementationOnce(async () => {
      r.session.setChannel('left'); // …which the browser notices while it rebuilds for the native path
    });
    back.say(state());
    await flush();
    const after = back.messages.slice(back.messages.findIndex((m) => m.type === 'channel'));
    expect(after).toEqual([
      { type: 'channel', choice: 'left' },
      { type: 'trim', db: 0 },
      { type: 'mains', hz: 50 },
      { type: 'master', db: -3, muted: false },
    ]);
  });

  it('remembers the tone offsets set while the browser played and sends them when the engine takes over', async () => {
    const r = rig();
    r.session.setPreset(preset, null);
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(5000);
    // «Звук как в песне» turns on while the browser plays.
    r.session.setToneOffsets({ bass: 1, mid: 0, treble: -2 });
    const back = latest();
    back.open();
    back.say(state({ status: 'idle' }));
    await flush();
    expect(sent(back, 'preset').at(-1)).toEqual({ type: 'preset', preset, toneOffsets: { bass: 1, mid: 0, treble: -2 } });
    back.say(state());
    await flush();
    expect(sent(back, 'preset').at(-1)).toEqual({ type: 'preset', preset, toneOffsets: { bass: 1, mid: 0, treble: -2 } });
    // Once the native path plays, a change goes out at once.
    r.session.setToneOffsets(null);
    expect(back.messages.at(-1)).toEqual({ type: 'preset', preset, toneOffsets: null });
  });

  it('keeps a connected engine quiet while the browser plays: nothing is sent to it', async () => {
    const r = rig();
    const started = r.session.start();
    latest().open();
    latest().say(state({ status: 'idle' }));
    await flush();
    latest().say(state({ status: 'error', error: 'Карта занята другой программой.' }));
    expect(await started).toBeNull();
    const socket = latest();
    const before = socket.sent.length;
    r.session.setPreset(preset, null);
    r.session.setChannel('left');
    r.session.setMaster(-3, false);
    expect(socket.sent).toHaveLength(before);
    // The next knock at the card carries it all, with the master muted: the browser still plays.
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.messages.slice(before)).toEqual([
      { type: 'open', device: CONFIG.device, buffer: 64 },
      { type: 'preset', preset, toneOffsets: null },
      { type: 'channel', choice: 'left' },
      { type: 'trim', db: 0 },
      { type: 'mains', hz: 50 },
      { type: 'master', db: -3, muted: true },
    ]);
  });

  it('does not send the preset to the engine while the browser plays', async () => {
    const r = rig();
    const started = r.session.start();
    latest().drop();
    await started;
    r.session.setPreset(preset, null);
    r.session.setChannel('left');
    r.session.setMaster(0, false);
    expect(FakeSocket.instances.flatMap((s) => s.sent)).toEqual([]);
  });
});

describe('NativeSession: stop', () => {
  it('tells the engine and lets go of the socket for good', async () => {
    const r = rig();
    const socket = await startNative(r);
    r.session.stop();
    expect(socket.messages.at(-1)).toEqual({ type: 'close' });
    expect(socket.closed).toBe(true);
    expect(rt().native).toEqual({ link: 'off', state: null, stats: null, note: null });
    expect(r.session.path).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(r.host.switchPath).not.toHaveBeenCalled();
  });

  it('cancels a fallback that was waiting', async () => {
    const r = rig();
    const socket = await startNative(r);
    socket.drop();
    await vi.advanceTimersByTimeAsync(2000);
    r.session.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.host.switchPath).not.toHaveBeenCalled();
    expect(rt().toast).toBeNull();
  });

  it('can start again after a stop', async () => {
    const r = rig();
    await startNative(r);
    r.session.stop();
    const socket = await startNative(r);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(socket.types.slice(0, 2)).toEqual(['hello', 'open']);
  });
});

describe('helpers', () => {
  it('encodes bytes as base64, also past the size of one chunk', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(bytesToBase64(new TextEncoder().encode('Ma'))).toBe('TWE=');
    expect(bytesToBase64(new TextEncoder().encode('M'))).toBe('TQ==');
    const big = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 31 + (i >> 8)) & 255);
    const back = atob(bytesToBase64(big));
    expect(back.length).toBe(big.length);
    for (let i = 0; i < big.length; i += 997) expect(back.charCodeAt(i)).toBe(big[i]);
    expect(back.charCodeAt(big.length - 1)).toBe(big[big.length - 1]);
  });

  it('builds the socket address from the page address', () => {
    const page = { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' };
    expect(guitarUrl(page, null)).toBe('ws://localhost:5173/guitar');
    expect(guitarUrl({ protocol: 'https:', host: 'kv.local', hostname: 'kv.local' }, null)).toBe('wss://kv.local/guitar');
    // The installed app: the engine on its own port, next to the page's host.
    expect(guitarUrl({ protocol: 'http:', host: '127.0.0.1:49152', hostname: '127.0.0.1' }, 49153)).toBe(
      'ws://127.0.0.1:49153/guitar',
    );
  });

  it('turns the engine latency into an estimate with no browser processing', () => {
    expect(nativeLatency({ input: 8.24, output: 5.04 })).toEqual({
      inputMs: 8.2,
      processingMs: 0,
      outputMs: 5,
      totalMs: 13.2,
      inputEstimated: false,
    });
    expect(nativeLatency(null)).toBeNull();
  });

  it('reads the output level from the stats, with the browser path floor of −120 dB', () => {
    expect(outputDbFromStats(null, 'peak')).toBe(-120);
    expect(outputDbFromStats(stats({ outPeakDb: -200, outRmsDb: -200 }), 'peak')).toBe(-120);
    expect(outputDbFromStats(stats({ outPeakDb: -200, outRmsDb: -200 }), 'rms')).toBe(-120);
    expect(outputDbFromStats(stats({ outPeakDb: -9, outRmsDb: -18 }), 'peak')).toBe(-9);
    expect(outputDbFromStats(stats({ outPeakDb: -9, outRmsDb: -18 }), 'rms')).toBe(-18);
  });
});
