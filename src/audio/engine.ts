// The audio engine: one AudioContext, the guitar input and what is done with it.
//
// Two paths, one of which is in use at a time (`useRuntime.guitarPath`):
//
//   browser: input → channel pick → hum filter → gate → amp (NAM / simple) → EQ → cabinet → chorus → delay
//            → reverb → preset level → master → soft clip → speakers
//   native:  the amp lives in the native engine (kv_guitar, ASIO) and the browser never opens
//            the microphone. The engine streams the raw input over a WebSocket; this context only
//            analyses it (meter, tuner, notes, «Проверь меня») and sends the preset, the master
//            volume and the channel choice back. `NativeSession` keeps the path right: a failed
//            start or a lost engine moves the guitar to the browser, a returning engine moves it back.
import type { MainsHz } from '../dsp/mains';
import { NamEngine } from 'neural-amp-modeler-wasm/engine';
import { ChannelPicker, channelGains, channelStep, type ChannelChoice, type ChannelMode } from '../dsp/channel';
import { makeSoftClipCurve } from '../dsp/curves';
import { driverStuck, estimateLatency } from '../dsp/latency';
import { MeterBallistics, dbToLin, levelZone, linToDb, measure, type LevelZone } from '../dsp/level';
import { describePitch, freqToMidi, nearestString, type NoteReading, STANDARD_TUNING } from '../dsp/notes';
import { PitchSmoother, detectPitch } from '../dsp/pitch';
import { L } from '../i18n';
import { ArrivalClock } from '../record/clock';
import { audibleMoment, tapNode, type BlockSink, type TrackSource } from '../record/tap';
import type { Preset, ReverbType } from '../state/presets';
import { useRuntime, type GuitarPath } from '../state/runtime';
import { currentPreset, guitarOutDb, useSettings, type SettingsState } from '../state/settings';
import { AmpSlot } from './amp';
import { buildAnalysis, makeAnalyser, type Analysis } from './analysis';
import { NO_CAB, loadIrBuffer, loadReverbBuffer, loadUserAssetBytes } from './assets';
import { createCabinet, createChorus, createDelay, createEq, createReverb, smooth } from './effects';
import { EngineError, listDevices, openInput } from './input';
import { buildNativeGraph, createNativeContext } from './native/graph';
import type { EngineState, ToneOffsets } from './native/protocol';
import { NativeSession, nativeLatency, outputDbFromStats, textDriverStuck } from './native/session';
import gateWorkletUrl from './worklets/gate.worklet.ts?worker&url';
import streamWorkletUrl from './worklets/stream.worklet.ts?worker&url';

export interface InputSnapshot {
  /** Meter level of the guitar channel as the amps get it (after the input's trim), dBFS (with ballistics). */
  levelDb: number;
  /** Recent peak, the same way, dBFS. */
  holdDb: number;
  /** This frame's peak of the guitar channel as the card gave it (before the trim), dBFS. */
  rawPeakDb: number;
  zone: LevelZone;
  freq: number | null;
  note: NoteReading | null;
  string: { stringNumber: number; cents: number } | null;
  channel: ChannelChoice;
}

/** The browser path's amp chain, after the shared analysis part. */
type Chain = Awaited<ReturnType<typeof buildChain>>;

/**
 * Makeup gain after the presets. Preset levels are balanced on a real DI guitar peaking at
 * -9 dBFS: about -21 dB RMS out (solo 1.5 dB louder). It was +3 (-18 dB RMS) until 2026-11-16:
 * then the clean preset's peaks reached the soft clip and the guitar plus the song (the card adds
 * the two streams) went over full scale on hard strums. 3 dB of headroom for both (the song's
 * target went down with it, `SONG_TARGET_DB`); the listening level is the card's own knob.
 */
const OUTPUT_TRIM_DB = 0;

const rt = () => useRuntime.getState();

/** gate → amp → EQ → cabinet → chorus → delay → reverb → level → master → soft clip → speakers. */
async function buildChain(ctx: AudioContext, nam: NamEngine | null, gate: AudioNode) {
  const amp = await AmpSlot.create(ctx, nam);
  const eq = createEq(ctx);
  const cab = createCabinet(ctx);
  const chorus = createChorus(ctx);
  const delay = createDelay(ctx);
  const reverb = createReverb(ctx);
  const level = ctx.createGain();
  const master = ctx.createGain();
  const clip = ctx.createWaveShaper();
  clip.curve = makeSoftClipCurve();
  const anOut = makeAnalyser(ctx, 2048);

  gate.connect(amp.input);
  amp.output.connect(eq.input);
  eq.output.connect(cab.input);
  cab.output.connect(chorus.input);
  chorus.output.connect(delay.input);
  delay.output.connect(reverb.input);
  reverb.output.connect(level).connect(master).connect(clip).connect(ctx.destination);
  clip.connect(anOut);

  return { amp, eq, cab, chorus, delay, reverb, level, master, clip, anOut };
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  /** The analysis nodes of whichever path is in use. */
  private an: Analysis | null = null;
  /** The amp chain: the browser path only. */
  private chain: Chain | null = null;
  private path: GuitarPath | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private applied: Preset | null = null;
  private starting: Promise<void> | null = null;
  private startingEpoch = 0;
  /** Bumped by every full teardown: a build begun before it must not commit. */
  private epoch = 0;
  /** The end of the queue of path builds (see `exclusive`). */
  private pathLock: Promise<unknown> = Promise.resolve();
  private raf = 0;
  private lastFrame = 0;
  private readonly session: NativeSession;
  private readonly frameListeners = new Set<(s: InputSnapshot, now: number) => void>();
  private readonly picker = new ChannelPicker();
  private readonly smoother = new PitchSmoother();
  private readonly ballistics = new MeterBallistics();
  /** Slower peak memory for the level advice, so it does not flicker between notes. */
  private readonly zoneMeter = new MeterBallistics(24, 3000);
  private channelMode: ChannelMode = 'auto';
  private channel: ChannelChoice | null = null;
  /** «Запись», native path: where the engine's raw input frames go too (the dry guitar). */
  private inputTap: BlockSink | null = null;
  /** «Подстроить под мою гитару»: the input's own gain, dB, before the hum filter, the gate and the amp. */
  private trimDb = 0;
  /** The mains the hum filter notches (src/dsp/mains.ts). */
  private mainsHz: MainsHz = 50;
  private a4 = 440;
  /** Open strings the tuner names («1-я струна»…): the open song's tuning, standard otherwise. */
  private tuningStrings: readonly number[] = STANDARD_TUNING;
  /** «Звук как в песне»: EQ change on top of the preset while a song asks for it, dB. */
  private toneEq = { bass: 0, mid: 0, treble: 0 };
  /** The same as asked for (null = none): what the native engine is sent. */
  private toneAsked: ToneOffsets | null = null;
  /** The native engine's amp message already shown as a toast. */
  private ampToast: string | null = null;
  private muted = false;
  private masterDb = 0;
  /** The «driver is stuck» toast was shown for the card as it is open now. */
  private driverStuckToast = false;
  private bufL = new Float32Array(2048);
  private bufR = new Float32Array(2048);
  private bufMono = new Float32Array(4096);
  private readonly onDeviceChange = () => void this.handleDeviceChange();

  constructor() {
    this.session = new NativeSession({
      host: {
        switchPath: (path, state) => this.switchPath(path, state),
        nativeState: (state) => this.nativeState(state),
      },
      config: () => {
        const { nativeDevice, nativeBuffer } = useSettings.getState();
        return { device: nativeDevice, buffer: nativeBuffer };
      },
      loadAsset: loadUserAssetBytes,
    });
  }

  get running(): boolean {
    return this.an !== null;
  }

  /** Who plays the guitar now (null while stopped). */
  get guitarPath(): GuitarPath | null {
    return this.path;
  }

  /**
   * «Запись»: what the guitar path plays (after the master and the soft clip), block by block, on
   * the path's own clock, and when the player hit the strings for a frame. `onInput` gets the
   * card's raw input on the same clock — both halves, before the channel pick, the hum filter and
   * the gate (the dry guitar, to check the input's noise and level by). Null while stopped.
   */
  async recordGuitar(onBlock: BlockSink, onInput?: BlockSink): Promise<TrackSource | null> {
    const ctx = this.ctx;
    const an = this.an;
    if (!ctx || !an) return null;
    if (this.path === 'native') {
      const session = this.session;
      const clock = new ArrivalClock(session.state?.sampleRate || 48000);
      session.onOutput = (frame0, left, right) => {
        clock.note(frame0 + left.length, performance.now());
        onBlock(frame0, left, right);
      };
      // The input frames carry the same frame numbers: the engine made output frame f from input frame f.
      this.inputTap = onInput ?? null;
      session.setRecording(true);
      return {
        rate: clock.rate,
        // The engine made frame f from the input it captured `input` ms before.
        moment: (frame) => {
          const made = clock.moment(frame);
          return made === null ? null : made - (session.state?.latencyMs?.input ?? 0);
        },
        stop: () => {
          session.setRecording(false);
          session.onOutput = null;
          this.inputTap = null;
        },
      };
    }
    const clip = this.chain?.clip;
    if (!clip) return null;
    const untap = await tapNode(ctx, clip, onBlock);
    // The raw input as the splitter hands it on (it outlives a change of input device).
    let untapInput = () => {};
    if (onInput) {
      const both = ctx.createChannelMerger(2);
      an.splitter.connect(both, 0, 0);
      an.splitter.connect(both, 1, 1);
      const untapBoth = await tapNode(ctx, both, onInput);
      untapInput = () => {
        untapBoth();
        try {
          an.splitter.disconnect(both);
        } catch {
          /* the graph is already gone */
        }
      };
    }
    return {
      rate: ctx.sampleRate,
      // Frame f reached the speakers at its audible moment; the string was hit a whole round trip before.
      moment: (frame) => audibleMoment(ctx, frame) - (rt().latency?.totalMs ?? 0),
      stop: () => {
        untap();
        untapInput();
      },
    };
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Starts sound. Call from a click or key press (browsers require a user gesture). */
  start(): Promise<void> {
    if (this.an) return Promise.resolve();
    if (this.starting && this.startingEpoch === this.epoch) return this.starting;
    // A start that a teardown overtook (it ends without doing anything) is waited for, then this one runs.
    this.startingEpoch = this.epoch;
    const overtaken = this.starting;
    // (Without one, doStart begins at once, still inside the user's click or key press.)
    const run: Promise<void> = (overtaken ? overtaken.then(() => this.doStart()) : this.doStart()).finally(() => {
      if (this.starting === run) this.starting = null;
    });
    this.starting = run;
    return run;
  }

  private async doStart(): Promise<void> {
    const settings = useSettings.getState();
    const epoch = this.epoch;
    rt().patch({ status: 'starting', error: null });
    try {
      if (typeof AudioWorkletNode === 'undefined' || !window.isSecureContext) throw new EngineError('unsupported');
      this.channelMode = settings.channelMode;
      this.a4 = settings.a4;
      this.masterDb = guitarOutDb(settings);
      this.muted = rt().muted;
      let native: EngineState | null = null;
      if (settings.guitarEngine === 'native') {
        // The engine plays the moment it is open: it needs the preset, master and channel first.
        this.session.setPreset(currentPreset(settings), this.toneAsked);
        this.session.setMaster(this.masterDb, this.muted);
        this.session.setChannel(settings.channelMode === 'auto' ? this.picker.current : settings.channelMode);
        native = await this.session.start();
      }
      if (epoch !== this.epoch) return; // stopped while it connected: whoever stopped it owns the status now
      // Through the same lock as the session's switches: if the engine wakes up while the browser
      // path is still being built (a microphone prompt takes seconds), its return waits for the build.
      await this.exclusive(() => {
        const fresh = useSettings.getState();
        return native ? this.buildNative(native, fresh, epoch) : this.buildBrowser(fresh, epoch);
      });
    } catch (error) {
      if (epoch !== this.epoch) return;
      await this.teardown();
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    const e = error instanceof EngineError ? error : new EngineError('other', String(error));
    rt().patch({ status: 'error', error: { kind: e.kind, detail: e.message } });
  }

  /** Path builds run one at a time: a switch waits for the build in progress, never tears it down. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pathLock.then(task);
    this.pathLock = run.catch(() => undefined);
    return run;
  }

  /** What a build made before it was committed: let go of it (the build was stale or failed). */
  private discard(ctx: AudioContext, stream: MediaStream | null): void {
    stream?.getTracks().forEach((t) => t.stop());
    if (ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }

  /**
   * The browser path: the microphone, the amp chain and the speakers, all in this context.
   * Nothing of the engine is touched until the very end, and only if `epoch` is still current:
   * a build that was overtaken (the engine was stopped meanwhile) lets go of what it made and
   * returns false.
   */
  private async buildBrowser(settings: SettingsState, epoch: number): Promise<boolean> {
    const ctx = new AudioContext({ latencyHint: settings.latencyMode === 'fast' ? 'interactive' : 'balanced' });
    let stream: MediaStream | null = null;
    let committed = false;
    try {
      const resumed = ctx.resume();
      stream = await openInput(settings.inputDeviceId);
      await resumed;
      await ctx.audioWorklet.addModule(gateWorkletUrl);
      let nam: NamEngine | null = null;
      try {
        nam = await NamEngine.attach(ctx, { assetBaseUrl: `${import.meta.env.BASE_URL}nam/` });
      } catch (error) {
        console.warn('[engine] NAM engine unavailable', error);
      }
      const an = buildAnalysis(ctx);
      an.trim.gain.value = dbToLin(this.trimDb);
      an.hum.setMains(this.mainsHz);
      const chain = await buildChain(ctx, nam, an.gate);
      if (epoch !== this.epoch) return false;
      committed = true;
      this.ctx = ctx;
      this.an = an;
      this.chain = chain;
      this.path = 'browser';
      this.attachStream(stream);
    } finally {
      if (!committed) this.discard(ctx, stream);
    }

    this.applyMaster();
    this.applyChannel(settings.channelMode === 'auto' ? this.picker.current : settings.channelMode);
    if (settings.outputDeviceId) {
      await this.setOutputDevice(settings.outputDeviceId).catch(() => undefined);
      if (epoch !== this.epoch) return false; // stopped meanwhile: it is all torn down already
    }

    rt().patch({
      status: 'running',
      guitarPath: 'browser',
      sampleRate: ctx.sampleRate,
      canPickOutput: typeof (ctx as AudioContext & { setSinkId?: unknown }).setSinkId === 'function',
    });
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    void this.refreshDevices();
    this.updateLatency();
    setTimeout(() => this.updateLatency(), 1500);
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
    await this.applyPreset(currentPreset(useSettings.getState()));
    return true;
  }

  /**
   * The native path: no microphone, no amp chain, no sound from this context. The context runs at
   * the engine's sample rate; the engine's stream plays into the analysers. Commits like
   * `buildBrowser`.
   */
  private async buildNative(state: EngineState, settings: SettingsState, epoch: number): Promise<boolean> {
    const ctx = createNativeContext(state);
    let committed = false;
    try {
      await ctx.resume();
      await ctx.audioWorklet.addModule(gateWorkletUrl);
      await ctx.audioWorklet.addModule(streamWorkletUrl);
      const graph = buildNativeGraph(ctx);
      graph.trim.gain.value = dbToLin(this.trimDb);
      graph.hum.setMains(this.mainsHz);
      if (epoch !== this.epoch) return false;
      committed = true;
      this.ctx = ctx;
      this.an = graph;
      this.path = 'native';
      // One 10 ms chunk at a time; the arrays are fresh, so they move to the worklet without a copy.
      // «Запись» gets copies first (the dry guitar), only while it records.
      this.session.onFrame = (frame0, left, right) => {
        this.inputTap?.(frame0, left.slice(), right.slice());
        graph.stream.port.postMessage({ left, right }, [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer]);
      };
      this.smoother.reset();

      const preset = currentPreset(settings);
      this.applied = preset; // the session already holds it: the engine got it with `open`
      graph.hum.set(preset.amp.hum);
      graph.gate.port.postMessage({ thresholdDb: preset.amp.gateDb, auto: preset.amp.gateAuto });
    } finally {
      if (!committed) this.discard(ctx, null);
    }
    this.applyMaster();
    this.applyChannel(settings.channelMode === 'auto' ? this.picker.current : settings.channelMode);

    rt().patch({ status: 'running', guitarPath: 'native', sampleRate: ctx.sampleRate, canPickOutput: false });
    // The engine may have said more than `state` while this was built (the amp finished loading,
    // the card reported its latency): show the newest.
    this.nativeState(this.session.state ?? state);
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
    return true;
  }

  /** The session moved the guitar to the other path (the engine was lost, or came back). */
  private switchPath(path: GuitarPath, state: EngineState | null): Promise<void> {
    const epoch = this.epoch;
    return this.exclusive(async () => {
      if (epoch !== this.epoch) return;
      await this.teardownAudio();
      const settings = useSettings.getState();
      try {
        if (path === 'native' && state) await this.buildNative(state, settings, epoch);
        else await this.buildBrowser(settings, epoch);
      } catch (error) {
        if (epoch !== this.epoch) return;
        await this.teardown();
        this.reportFailure(error);
      }
    });
  }

  async stop(): Promise<void> {
    await this.teardown();
    rt().patch({ status: 'idle' });
  }

  /** Rebuilds the context, e.g. after switching the latency mode or the guitar engine. */
  async restart(): Promise<void> {
    await this.teardown();
    await this.start();
  }

  /** Everything is let go, the native engine included. */
  private async teardown(): Promise<void> {
    this.epoch++;
    this.session.stop();
    await this.teardownAudio();
    rt().patch({ guitarPath: null });
  }

  /** The audio of the current path only: the session (and the native engine) carry on. */
  private async teardownAudio(): Promise<void> {
    cancelAnimationFrame(this.raf);
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
    this.session.onFrame = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.an = null;
    this.chain = null;
    this.path = null;
    this.applied = null;
    this.channel = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined);
  }

  /** Null: no input («Без входа»), the microphone is released. */
  private attachStream(stream: MediaStream | null): void {
    const ctx = this.ctx;
    const an = this.an;
    if (!ctx || !an) return;
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    if (!stream) {
      this.source = null;
      this.smoother.reset();
      rt().patch({ activeInputLabel: null, inputLost: false });
      return;
    }
    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(an.splitter);
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        if (this.stream === stream) {
          rt().patch({ inputLost: true });
          rt().showToast(L().input.inputLost, 'warn');
        }
      });
    }
    this.smoother.reset();
    rt().patch({ activeInputLabel: track?.label || null, inputLost: false });
  }

  /** The browser's input device. In the native path the engine's device is chosen instead. */
  async setInputDevice(id: string | null): Promise<void> {
    if (this.path !== 'browser') return;
    try {
      this.attachStream(await openInput(id));
      this.updateLatency();
      void this.refreshDevices();
    } catch (error) {
      const message = error instanceof EngineError && error.kind === 'busy' ? L().input.deviceBusy : L().input.deviceFailed;
      rt().showToast(message, 'warn');
    }
  }

  async setOutputDevice(id: string | null): Promise<void> {
    if (this.path !== 'browser') return; // the native path makes no sound here
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try {
      await ctx.setSinkId(id ?? '');
      this.updateLatency();
    } catch {
      rt().showToast(L().input.outputFailed, 'warn');
    }
  }

  /** The native engine's device or buffer changed: it opens the card again. */
  reopenNative(): void {
    this.session.reopen();
  }

  setChannelMode(mode: ChannelMode): void {
    this.channelMode = mode;
    this.applyChannel(mode === 'auto' ? this.picker.current : mode);
  }

  /** «Подстроить под мою гитару»: the input's own gain, dB (both paths; the native engine gets it too). */
  setInputTrim(db: number): void {
    this.trimDb = db;
    if (this.ctx && this.an) smooth(this.an.trim.gain, dbToLin(db), this.ctx);
    this.session.setTrim(db);
  }

  /** The mains the hum filter notches, in both paths (the native engine gets it too). */
  setMains(hz: MainsHz): void {
    this.mainsHz = hz;
    this.an?.hum.setMains(hz);
    this.session.setMains(hz);
  }

  /** The last 0.68 s of the input before the hum filter, for telling 50 Hz mains from 60 Hz. */
  readHumWindow(): { samples: Float32Array; sampleRate: number } | null {
    if (!this.ctx || !this.an) return null;
    const samples = new Float32Array(this.an.humTap.fftSize);
    this.an.humTap.getFloatTimeDomainData(samples);
    return { samples, sampleRate: this.ctx.sampleRate };
  }

  setA4(hz: number): void {
    this.a4 = hz;
  }

  /** The guitar's tuning for the tuner's string names (MIDI notes, 6th string first). */
  setTuning(strings: readonly number[]): void {
    this.tuningStrings = strings;
  }

  /** The guitar's output level: the master plus the guitar's own volume (`guitarOutDb`). */
  setMasterDb(db: number): void {
    this.masterDb = db;
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  /** «Звук как в песне»: bass / mid / treble added to the preset's EQ (null = none). */
  setToneOffsets(offsets: { bass: number; mid: number; treble: number } | null): void {
    this.toneAsked = offsets;
    this.toneEq = offsets ?? { bass: 0, mid: 0, treble: 0 };
    // Remembered by the session always: the native engine must have the song's tone when it takes
    // over from the browser path, whenever the tone changed.
    this.session.setToneOffsets(offsets);
    const preset = this.applied;
    const chain = this.chain;
    if (preset && chain && this.path === 'browser') this.applyEq(chain, preset);
  }

  /** The EQ offsets in use (for checks). */
  toneOffsets(): { bass: number; mid: number; treble: number } {
    return { ...this.toneEq };
  }

  /** Fills `out` (8192 / 2 bins) with the gated guitar's spectrum in dB; returns the sample rate (0 when stopped). */
  readSpectrum(out: Float32Array<ArrayBuffer>): number {
    const an = this.an;
    if (!an || !this.ctx) return 0;
    an.anSpec.getFloatFrequencyData(out);
    return this.ctx.sampleRate;
  }

  private applyEq(chain: Chain, preset: Preset): void {
    const t = this.toneEq;
    chain.eq.set(preset.amp.bass + t.bass, preset.amp.mid + t.mid, preset.amp.treble + t.treble);
  }

  /** Applies a preset; reloads the model or IRs only when they actually change. */
  async applyPreset(preset: Preset): Promise<void> {
    // The native engine gets it whenever the native path plays (or is being opened); remembered always.
    this.session.setPreset(preset, this.toneAsked);
    const ctx = this.ctx;
    const an = this.an;
    if (!ctx || !an) return;
    const prev = this.applied;
    this.applied = preset;

    an.hum.set(preset.amp.hum);
    // In the native path this gate only feeds «Проверь меня»; the engine has its own, set the same.
    an.gate.port.postMessage({ thresholdDb: preset.amp.gateDb, auto: preset.amp.gateAuto });
    const chain = this.chain;
    if (this.path !== 'browser' || !chain) return;

    chain.amp.setDrive(preset.amp.inputDb);
    this.applyEq(chain, preset);
    chain.chorus.set(preset.chorus);
    chain.delay.set(preset.delay);
    chain.reverb.set(preset.reverb);
    smooth(chain.level.gain, dbToLin(preset.amp.levelDb + OUTPUT_TRIM_DB), ctx);

    const jobs: Promise<void>[] = [];
    if (!prev || prev.amp.model !== preset.amp.model || prev.amp.slim !== preset.amp.slim) {
      jobs.push(this.loadModel(preset.amp.model, preset.amp.slim));
    }
    if (!prev || prev.cab !== preset.cab) jobs.push(this.loadCab(preset.cab));
    if (!prev || prev.reverb.type !== preset.reverb.type) jobs.push(this.loadReverb(preset.reverb.type));
    await Promise.all(jobs);
  }

  private async loadModel(id: string, slim: boolean): Promise<void> {
    const chain = this.chain;
    if (!chain) return;
    rt().patch({ amp: { state: 'loading' } });
    const result = await chain.amp.setModel(id, slim);
    if (result.kind === 'stale' || this.chain !== chain) return;
    const error = result.kind === 'simple' ? result.error : undefined;
    if (!error) {
      rt().patch({ amp: { state: 'ready' } });
    } else {
      rt().patch({ amp: { state: 'fallback', message: error } });
      rt().showToast(error, 'warn');
    }
  }

  private async loadCab(id: string): Promise<void> {
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain) return;
    if (id === NO_CAB) {
      chain.cab.setIr(null);
      return;
    }
    try {
      const buffer = await loadIrBuffer(ctx, id);
      if (this.chain === chain) chain.cab.setIr(buffer);
    } catch (error) {
      rt().showToast(error instanceof Error ? error.message : L().amp.cabinetFailed, 'warn');
    }
  }

  private async loadReverb(type: ReverbType): Promise<void> {
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain) return;
    try {
      const buffer = await loadReverbBuffer(ctx, type);
      if (this.chain === chain) chain.reverb.setIr(buffer);
    } catch (error) {
      rt().showToast(error instanceof Error ? error.message : L().amp.reverbFailed, 'warn');
    }
  }

  private applyMaster(): void {
    this.session.setMaster(this.masterDb, this.muted); // M mutes the guitar only: the song plays on
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain) return;
    smooth(chain.master.gain, this.muted ? 0 : dbToLin(this.masterDb), ctx, 0.02);
  }

  private applyChannel(choice: ChannelChoice): void {
    const ctx = this.ctx;
    const an = this.an;
    if (!ctx || !an || choice === this.channel) return;
    const step = channelStep(this.channel, choice);
    if (step !== 1) an.gate.port.postMessage({ floorGain: step }); // the noise moves with the guitar
    this.channel = choice;
    const [l, r] = channelGains(choice);
    smooth(an.gainL.gain, l, ctx, 0.01);
    smooth(an.gainR.gain, r, ctx, 0.01);
    this.session.setChannel(choice); // the native engine picks the same channel for its amp
  }

  /** A new `state` of the native engine while its path plays: amp, device name, latency. */
  private nativeState(state: EngineState): void {
    const latency = nativeLatency(state.latencyMs);
    rt().patch({
      amp: state.amp,
      activeInputLabel: state.device,
      inputLost: false,
      latency,
    });
    // Once per stuck episode: a replugged card opens again with a healthy latency and resets it.
    const stuck = latency !== null && driverStuck(state.device, latency, state.buffer, state.sampleRate);
    if (stuck && !this.driverStuckToast) rt().showToast(textDriverStuck(), 'warn');
    if (latency !== null) this.driverStuckToast = stuck;
    const message = state.amp.state === 'fallback' ? state.amp.message : undefined;
    if (message && message !== this.ampToast) rt().showToast(message, 'warn');
    this.ampToast = message ?? null;
  }

  private updateLatency(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.path === 'native') {
      rt().patch({ latency: nativeLatency(this.session.state?.latencyMs ?? null) });
      return;
    }
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    rt().patch({
      latency: estimateLatency({
        baseLatency: ctx.baseLatency ?? 0,
        outputLatency: ctx.outputLatency ?? 0,
        inputLatency: settings?.latency ?? null,
      }),
    });
  }

  async refreshDevices(): Promise<void> {
    try {
      rt().patch(await listDevices());
    } catch {
      /* the list stays as it was */
    }
  }

  private async handleDeviceChange(): Promise<void> {
    await this.refreshDevices();
    if (!rt().inputLost || !this.an) return;
    try {
      this.attachStream(await openInput(useSettings.getState().inputDeviceId));
      rt().showToast(L().input.inputBack);
    } catch {
      /* still unplugged */
    }
  }

  /**
   * Subscribes to the per-frame meter / tuner snapshot. `now` is the frame's time
   * (`requestAnimationFrame`'s, performance.now() clock), the same for every listener of a frame.
   */
  onFrame(listener: (s: InputSnapshot, now: number) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** Output level after the whole chain, for checks (in the native path: the engine's own meter). */
  readOutputDb(kind: 'peak' | 'rms' = 'peak'): number {
    if (this.path === 'native') return outputDbFromStats(this.session.stats, kind);
    const chain = this.chain;
    if (!chain) return -120;
    const buf = new Float32Array(chain.anOut.fftSize);
    chain.anOut.getFloatTimeDomainData(buf);
    return linToDb(measure(buf)[kind]);
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const ctx = this.ctx;
    const an = this.an;
    if (!ctx || !an) return;
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;

    an.anL.getFloatTimeDomainData(this.bufL);
    an.anR.getFloatTimeDomainData(this.bufR);
    an.anMono.getFloatTimeDomainData(this.bufMono);
    const left = measure(this.bufL);
    const right = measure(this.bufR);

    if (this.channelMode === 'auto') {
      this.applyChannel(this.picker.update(linToDb(left.rms), linToDb(right.rms), dt));
    }
    const channel = this.channel ?? 'both';
    const peak = channel === 'left' ? left.peak : channel === 'right' ? right.peak : Math.max(left.peak, right.peak);
    const rawPeakDb = linToDb(peak);
    // The meter shows what the amps get; the card's own overload is judged before the trim.
    const { levelDb, holdDb } = this.ballistics.update(rawPeakDb + this.trimDb, now);
    const rawHoldDb = this.zoneMeter.update(rawPeakDb, now).holdDb;

    const freq = this.smoother.push(detectPitch(this.bufMono, ctx.sampleRate), now);
    const note = freq ? describePitch(freq, this.a4) : null;
    const snapshot: InputSnapshot = {
      levelDb,
      holdDb,
      rawPeakDb,
      zone: levelZone(rawHoldDb + this.trimDb, rawHoldDb),
      freq,
      note,
      string: freq ? nearestString(freqToMidi(freq, this.a4), this.tuningStrings) : null,
      channel,
    };
    for (const listener of this.frameListeners) listener(snapshot, now);
  };
}

export const engine = new AudioEngine();

if (import.meta.env.DEV) {
  (window as unknown as { __kvEngine: AudioEngine }).__kvEngine = engine;
}
