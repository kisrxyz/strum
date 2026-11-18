// The song player: all six stems in one 12-channel signalsmith-stretch node, so they never drift
// apart, with a gain per stem after the node.
//
//   stretch (12 ch) → splitter → per stem: merger (2 ch) → gain → bus → master → soft clip → out
//
// The song has its own AudioContext, separate from the guitar's. Each context renders on its own
// audio thread: the stretch (about 30 % of a core for 12 channels at 80 %) and the NAM amp
// (30–40 %) together overloaded one thread and made the sound drop out. The song's context uses
// large buffers ('playback'); its latency does not matter, you play along to what you hear.
//
// The player mirrors what it told the worklet (a Transport) and computes the position itself;
// the audible position uses the output timestamp, i.e. what reaches the speakers.
//
// Clicks on the song's beats and the count-in are short buffers scheduled ahead on the same
// context clock as the stretch node, so they stay on the beat at any speed; every change of the
// transport (seek, speed, loop, pause) cancels what was scheduled and schedules again.
//
// A loop's passes are counted (stage 4): «Повтори за мной» turns the original guitar on and off
// pass by pass with gain changes scheduled at the wrap times, and a timer tells listeners (the
// speed trainer) each time the loop comes round.
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';
import { smooth } from '../audio/effects';
import { makeSoftClipCurve } from '../dsp/curves';
import { dbToLin, linToDb, measure } from '../dsp/level';
import type { Bar } from '../music/bars';
import { audibleMoment, tapNode, type BlockSink, type TrackSource } from '../record/tap';
import { clicksBetween, countIn, type Click } from './clicks';
import { loopActive, motionAt, positionAt, wrapTimes, wrapsUntil, type Motion, type Transport } from './schedule';
import { STEMS, type Loop, type Stem } from './types';

/** The song's beat grid for clicks and the count-in (bar lines already moved by the user's shift). */
export interface BeatGrid {
  beats: number[];
  /** Bar starts. */
  downbeats: number[];
  bars: Bar[];
}

export type PlayerSource =
  | { kind: 'mix'; url: string }
  | { kind: 'stems'; urls: Record<Stem, string> }
  /** Stems the app made itself (a tab-song): the 12 channels in `STEMS` order at the context's rate. */
  | { kind: 'pcm'; channels: Float32Array[] };

const DECODE_AT_ONCE = 3;
/** Clicks are scheduled this far ahead, refilled every CLICK_REFILL_MS. */
const CLICK_AHEAD = 1.0;
const CLICK_REFILL_MS = 200;
/** The count-in starts this long after the key press. */
const COUNT_IN_LEAD = 0.08;
const CLICK_LEVEL = 0.5;
const NO_LOOP: Loop = { start: 0, end: 0, on: false };
/** While only the mix is loaded it plays through this slot (the worklet copies it into all six). */
const MIX_SLOT: Stem = 'other';

interface Graph {
  ctx: AudioContext;
  node: StretchNode;
  bus: GainNode;
  master: GainNode;
  clickGain: GainNode;
  clickBuffers: { accent: AudioBuffer; beat: AudioBuffer };
  gains: Record<Stem, GainNode>;
  analysers: Record<Stem, AnalyserNode>;
  outAnalyser: AnalyserNode;
  /** What goes to the speakers (tapped by «Запись»). */
  clip: WaveShaperNode;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** A short sine blip with a fast decay: higher for the first beat of the bar. */
function clickBuffer(ctx: BaseAudioContext, freq: number, amp: number): AudioBuffer {
  const length = Math.round(ctx.sampleRate * 0.05);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / ctx.sampleRate;
    data[i] = amp * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.012) * Math.min(1, i / 24);
  }
  return buffer;
}

async function decode(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

/** Copies `buffer` (decoded at the context rate) into channels `left` and `left + 1`. */
function copyInto(channels: Float32Array[], buffer: AudioBuffer, left: number): void {
  const frames = Math.min(buffer.length, channels[left].length); // a slightly longer decode is cut
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  channels[left].set(l.subarray(0, frames));
  channels[left + 1].set(r.subarray(0, frames));
}

export class SongPlayer {
  private graph: Graph | null = null;
  private attaching: Promise<void> | null = null;
  private loadToken = 0;
  private loaded = false;
  private mixOnly = false;
  private duration = 0;
  private transport: Transport = { at: 0, pos: 0, rate: 1, playing: false };
  private loop: Loop = NO_LOOP;
  private semitones = 0;
  private gains: Record<Stem, number> = { vocals: 1, drums: 1, bass: 1, guitar: 0, piano: 1, other: 1 };
  private busDb = 0;
  private masterGain = 1;
  private sinkId: string | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly endedListeners = new Set<() => void>();
  private probe = new Float32Array(2048);
  private grid: BeatGrid | null = null;
  private clickOn = false;
  private countInOn = false;
  /** Scheduled clicks; `countIn` ones belong to a count-in and outlive a click or grid change. */
  private clickVoices: { source: AudioBufferSourceNode; time: number; countIn: boolean }[] = [];
  private clickTimer: ReturnType<typeof setInterval> | null = null;
  /** Clicks are scheduled up to this context time. */
  private clicksUntil = 0;
  /** Passes of the loop completed before `transport.at` (0 = the first time through a new loop). */
  private passBase = 0;
  /** The last pass the wrap listeners were told about. */
  private toldPass = 0;
  private passTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wrapListeners = new Set<(pass: number) => void>();
  /** «Повтори за мной»: the original guitar's gain in the «слушай» passes; null = off. */
  private repeatGain: number | null = null;

  get attached(): boolean {
    return this.graph !== null;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** The song context's sample rate (null until it is attached): a tab-song is rendered at it. */
  get sampleRate(): number | null {
    return this.graph?.ctx.sampleRate ?? null;
  }

  get playing(): boolean {
    return this.transport.playing;
  }

  get context(): AudioContext | null {
    return this.graph?.ctx ?? null;
  }

  /** Creates the song's own audio context and node, once. Call after a user gesture. */
  attach(): Promise<void> {
    if (this.graph) return Promise.resolve();
    this.attaching ??= this.build().finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }

  /** The browser may keep a new context suspended until a key press: call from key handlers. */
  resume(): void {
    const ctx = this.graph?.ctx;
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  }

  private async build(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    void ctx.resume().catch(() => undefined);
    if (this.sinkId) await this.applySink(ctx, this.sinkId);
    // numberOfInputs: 1 with nothing connected — 1.3.2 crashes on pause with 0 inputs.
    // outputChannelCount must match the 12 channels, or the worklet hits its configure() bug.
    const node = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [12] });
    await node.configure({ blockMs: 120, intervalMs: 30, splitComputation: true });
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 12 });
    const bus = new GainNode(ctx, { gain: dbToLin(this.busDb) });
    const master = new GainNode(ctx, { gain: this.masterGain });
    const clip = new WaveShaperNode(ctx, { curve: makeSoftClipCurve() });
    const outAnalyser = new AnalyserNode(ctx, { fftSize: 2048 });
    // Clicks join after the song bus: the song's own volume does not change them, the master does.
    const clickGain = new GainNode(ctx, { gain: CLICK_LEVEL });
    clickGain.connect(master);
    const clickBuffers = { accent: clickBuffer(ctx, 1760, 1), beat: clickBuffer(ctx, 1320, 0.7) };
    node.connect(splitter);
    const gains = {} as Record<Stem, GainNode>;
    const analysers = {} as Record<Stem, AnalyserNode>;
    STEMS.forEach((stem, i) => {
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      splitter.connect(merger, 2 * i, 0);
      splitter.connect(merger, 2 * i + 1, 1);
      const gain = new GainNode(ctx, { gain: 0 });
      const analyser = new AnalyserNode(ctx, { fftSize: 2048 });
      merger.connect(gain).connect(bus);
      gain.connect(analyser);
      gains[stem] = gain;
      analysers[stem] = analyser;
    });
    bus.connect(master).connect(clip).connect(ctx.destination);
    clip.connect(outAnalyser);
    this.graph = { ctx, node, bus, master, clickGain, clickBuffers, gains, analysers, outAnalyser, clip };
    this.loaded = false;
    this.transport = { at: ctx.currentTime, pos: 0, rate: this.transport.rate, playing: false };
  }

  /**
   * «Запись»: what the song player sends to the speakers (the stems, the clicks, after the master),
   * block by block on its context's clock, and when each frame was heard. Null before `attach`.
   */
  async recordBand(onBlock: BlockSink): Promise<TrackSource | null> {
    const graph = this.graph;
    if (!graph) return null;
    const { ctx, clip } = graph;
    const untap = await tapNode(ctx, clip, onBlock);
    return { rate: ctx.sampleRate, moment: (frame) => audibleMoment(ctx, frame), stop: untap };
  }

  /** The engine's master volume applies to the song too. M mutes only the guitar, not the song. */
  setMaster(db: number): void {
    this.masterGain = dbToLin(db);
    const graph = this.graph;
    if (graph) smooth(graph.master.gain, this.masterGain, graph.ctx, 0.02);
  }

  /** Same output device as the guitar. */
  async setOutputDevice(id: string | null): Promise<void> {
    this.sinkId = id;
    if (this.graph) await this.applySink(this.graph.ctx, id);
  }

  private async applySink(ctx: AudioContext, id: string | null): Promise<void> {
    const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    await withSink.setSinkId?.(id ?? '').catch(() => undefined);
  }

  /**
   * Loads a song paused at `at` seconds. Resolves false when a newer load (or a detach) took
   * over, so the caller does not apply a stale result.
   */
  async load(source: PlayerSource, duration: number, at: number): Promise<boolean> {
    const graph = this.graph;
    if (!graph) return false;
    const token = ++this.loadToken;
    const { ctx, node } = graph;
    this.loaded = false;
    this.cancelClicks(true);
    this.updateClickTimer();
    // While it loads the screen shows the place it will start from (a tab-song's swap takes a few
    // milliseconds: no flash of 0:00).
    this.transport = { at: ctx.currentTime, pos: Math.max(0, at), rate: this.transport.rate, playing: false };
    await node.schedule({ output: ctx.currentTime, active: false, input: 0 });
    await node.dropBuffers();

    // One buffer per channel for the whole song. signalsmith-stretch 1.3.2 breaks with several
    // buffers: reading from any but the last one overruns its copy loop (RangeError), and the
    // worklet goes silent for good.
    const frames = Math.max(1, Math.round(duration * ctx.sampleRate));
    let channels: Float32Array[];
    if (source.kind === 'pcm') {
      // Made for this context: the right rate and length already (a stray length is cut or padded).
      channels = source.channels.map((c) => {
        if (c.length === frames) return c;
        const sized = new Float32Array(frames);
        sized.set(c.subarray(0, frames));
        return sized;
      });
    } else {
      channels = Array.from({ length: source.kind === 'mix' ? 2 : 12 }, () => new Float32Array(frames));
      const files = source.kind === 'mix' ? [source.url] : STEMS.map((stem) => source.urls[stem]);
      // A few files at a time: each decode runs on its own thread, and only a few decoded copies
      // are alive at once (the song itself is already allocated above).
      let next = 0;
      const worker = async () => {
        while (next < files.length && token === this.loadToken) {
          const index = next++;
          const buffer = await decode(ctx, files[index]);
          if (token !== this.loadToken) return;
          copyInto(channels, buffer, 2 * index);
        }
      };
      await Promise.all(Array.from({ length: Math.min(DECODE_AT_ONCE, files.length) }, worker));
    }
    if (token !== this.loadToken) return false;
    // The arrays move to the audio thread without a copy; the mix's 2 are repeated over 12 channels.
    await node.addBuffers(channels, channels.map((a) => a.buffer));
    if (token !== this.loadToken) return false;

    this.duration = duration;
    this.mixOnly = source.kind === 'mix';
    this.loaded = true;
    this.passBase = 0;
    this.transport = { at: ctx.currentTime, pos: clamp(at, 0, duration), rate: this.transport.rate, playing: false };
    this.applyGains();
    this.commit({});
    return true;
  }

  unload(): void {
    this.loadToken++;
    this.loaded = false;
    this.cancelClicks(true);
    this.updateClickTimer();
    this.armPassTimer();
    const graph = this.graph;
    if (!graph) return;
    this.transport = { ...this.transport, playing: false };
    void graph.node.schedule({ output: graph.ctx.currentTime, active: false }).then(() => graph.node.dropBuffers());
  }

  /** `countIn: false`: go on at once even with «Отсчёт» on (the music was playing a moment ago). */
  play({ countIn: withCountIn = true }: { countIn?: boolean } = {}): void {
    if (!this.loaded || !this.graph) return;
    const pos = this.positionNow();
    const atEnd = !loopActive(this.loop) && pos >= this.duration - 0.05;
    const start = atEnd ? 0 : pos;
    const now = this.graph.ctx.currentTime;
    // «Отсчёт»: a bar of clicks, then the song from the start of the bar it was paused in.
    const plan =
      withCountIn && this.countInOn && this.grid ? countIn(this.grid.bars, start, this.transport.rate, now + COUNT_IN_LEAD) : null;
    if (!plan) {
      this.commit({ playing: true, pos: start });
      return;
    }
    this.commit({ playing: true, pos: plan.songPos }, plan.songStartsAt);
    for (const click of plan.clicks) this.playClick(click, true);
  }

  /** The beat grid of the open song (null: no analysis yet), for clicks and the count-in. */
  setGrid(grid: BeatGrid | null): void {
    this.grid = grid;
    this.restartClicks();
  }

  /** «Клик»: clicks on the song's beats while it plays. */
  setClick(on: boolean): void {
    this.clickOn = on;
    this.restartClicks();
  }

  /** «Отсчёт»: a bar of clicks before the song starts. */
  setCountIn(on: boolean): void {
    this.countInOn = on;
  }

  /** Context times of the clicks scheduled and not yet played (for checks). */
  scheduledClicks(): number[] {
    const now = this.graph?.ctx.currentTime ?? 0;
    return this.clickVoices.filter((v) => v.time >= now).map((v) => v.time);
  }

  pause(): void {
    if (!this.loaded || !this.graph) return;
    this.commit({ playing: false });
  }

  seek(pos: number): void {
    if (!this.loaded) return;
    this.commit({ pos: clamp(pos, 0, this.duration) });
  }

  setRate(rate: number): void {
    this.commit({ rate });
  }

  /** Total shift in semitones, cents included (−1.05 = a semitone and 5 cents down). */
  setPitch(semitones: number): void {
    this.semitones = semitones;
    this.commit({});
  }

  /** Turning a loop on while outside it jumps to its start. A new loop counts its passes from 0. */
  setLoop(loop: Loop): void {
    const pos = this.positionNow();
    this.loop = { ...loop };
    const inside = pos >= loop.start && pos < loop.end;
    this.commit(loopActive(loop) && !inside ? { pos: loop.start } : { pos }, undefined, true);
  }

  /**
   * «Повтори за мной»: while a loop is on, the original guitar plays at `listenGain` in the even
   * passes (0, 2, … «слушай») and is silent in the odd ones («играй»). null turns it off.
   */
  setRepeat(listenGain: number | null): void {
    this.repeatGain = listenGain;
    this.applyGuitar();
  }

  /** The pass of the loop being heard at `at` (performance.now() clock): 0 the first time through. */
  loopPass(at = performance.now()): number {
    const heard = this.heardAt(at);
    return heard === null ? this.passBase : this.passAt(heard);
  }

  /** Called each time the loop comes round, with the new pass number (a timer, a few ms late). */
  onLoopWrap(listener: (pass: number) => void): () => void {
    this.wrapListeners.add(listener);
    return () => {
      this.wrapListeners.delete(listener);
    };
  }

  setGains(gains: Record<Stem, number>): void {
    this.gains = { ...gains };
    this.applyGains();
  }

  setBusDb(db: number): void {
    this.busDb = db;
    const graph = this.graph;
    if (graph) smooth(graph.bus.gain, dbToLin(db), graph.ctx, 0.05);
  }

  /**
   * Song time that is reaching the speakers at `at` (performance.now() clock, now by default).
   * The screen passes the frame's time, so all its moving parts agree and step evenly.
   */
  position(at = performance.now()): number {
    const heard = this.heardAt(at);
    if (heard === null) return this.transport.pos;
    return clamp(positionAt(this.transport, this.loop, heard), 0, this.duration);
  }

  /** Like `position`, plus how fast the song moves there and until where (for the gliding lane). */
  motion(at = performance.now()): Motion {
    const heard = this.heardAt(at);
    if (heard === null) return { pos: this.transport.pos, rate: 0, until: this.transport.pos };
    return motionAt(this.transport, this.loop, heard, this.duration);
  }

  /** Context time of what reaches the speakers at `at` (performance.now() clock); null when not loaded. */
  private heardAt(at: number): number | null {
    const graph = this.graph;
    if (!graph || !this.loaded) return null;
    const { ctx } = graph;
    const ts = ctx.getOutputTimestamp();
    if (!ts.contextTime || !ts.performanceTime) return ctx.currentTime;
    return Math.min(ctx.currentTime, ts.contextTime + (at - ts.performanceTime) / 1000);
  }

  /** Stops at the end of the song when there is no loop (timer: frames stop in hidden windows). */
  private checkEnd(): void {
    this.endTimer = null;
    if (!this.loaded || !this.transport.playing || loopActive(this.loop)) return;
    const left = this.duration - this.positionNow();
    if (left > 0.01) {
      this.armEndTimer();
      return;
    }
    this.commit({ playing: false, pos: this.duration });
    for (const listener of this.endedListeners) listener();
  }

  private armEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (!this.loaded || !this.transport.playing || loopActive(this.loop)) return;
    const left = (this.duration - this.positionNow()) / this.transport.rate;
    this.endTimer = setTimeout(() => this.checkEnd(), Math.max(20, left * 1000 + 20));
  }

  onEnded(listener: () => void): () => void {
    this.endedListeners.add(listener);
    return () => {
      this.endedListeners.delete(listener);
    };
  }

  /** RMS level of one stem after its gain, dBFS (for checks). */
  readStemDb(stem: Stem): number {
    return this.readDb(this.graph?.analysers[stem]);
  }

  /** RMS level of the whole song at the output, dBFS (for checks). */
  readOutputDb(): number {
    return this.readDb(this.graph?.outAnalyser);
  }

  private readDb(analyser: AnalyserNode | undefined): number {
    if (!analyser) return -120;
    analyser.getFloatTimeDomainData(this.probe);
    return linToDb(measure(this.probe).rms);
  }

  /** Song time the worklet is rendering now (ahead of what is heard by the output latency). */
  private positionNow(): number {
    const graph = this.graph;
    if (!graph) return this.transport.pos;
    return positionAt(this.transport, this.loop, graph.ctx.currentTime);
  }

  /**
   * Applies a transport change at context time `at` (now by default; later for a count-in).
   * `newLoop`: the loop changed, its passes are counted afresh.
   */
  private commit(next: { pos?: number; playing?: boolean; rate?: number }, at?: number, newLoop = false): void {
    const graph = this.graph;
    if (!graph) return;
    const now = at ?? graph.ctx.currentTime;
    const pos = next.pos ?? this.positionNow();
    this.passBase = newLoop ? 0 : this.passAt(now);
    this.toldPass = this.passBase;
    this.transport = {
      at: now,
      pos,
      rate: next.rate ?? this.transport.rate,
      playing: next.playing ?? this.transport.playing,
    };
    this.cancelClicks(true);
    this.updateClickTimer();
    this.refillClicks();
    this.armPassTimer();
    this.applyGuitar();
    if (!this.loaded) return;
    this.armEndTimer();
    const looped = loopActive(this.loop);
    void graph.node.schedule({
      output: now,
      active: this.transport.playing,
      input: pos,
      rate: this.transport.rate,
      semitones: this.semitones,
      loopStart: looped ? this.loop.start : 0,
      loopEnd: looped ? this.loop.end : 0,
    });
  }

  private playClick(click: Click, countIn = false): void {
    const graph = this.graph;
    if (!graph || click.time < graph.ctx.currentTime) return;
    const source = new AudioBufferSourceNode(graph.ctx, {
      buffer: click.accent ? graph.clickBuffers.accent : graph.clickBuffers.beat,
    });
    source.connect(graph.clickGain);
    source.start(click.time);
    const voice = { source, time: click.time, countIn };
    this.clickVoices.push(voice);
    source.onended = () => {
      this.clickVoices = this.clickVoices.filter((v) => v !== voice);
    };
  }

  /** Stops the clicks that have not sounded yet: all of them, or only the beat clicks. */
  private cancelClicks(all: boolean): void {
    const now = this.graph?.ctx.currentTime ?? 0;
    const doomed = (v: { time: number; countIn: boolean }) => v.time >= now && (all || !v.countIn);
    for (const voice of this.clickVoices) {
      if (!doomed(voice)) continue;
      voice.source.onended = null;
      try {
        voice.source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.clickVoices = this.clickVoices.filter((v) => !doomed(v));
    this.clicksUntil = 0;
  }

  /** The click or the beat grid changed: the beat clicks are scheduled again, a count-in goes on. */
  private restartClicks(): void {
    this.cancelClicks(false);
    this.updateClickTimer();
    this.refillClicks();
  }

  private refillClicks(): void {
    const graph = this.graph;
    const grid = this.grid;
    if (!graph || !grid || !this.loaded || !this.clickOn || !this.transport.playing) return;
    const now = graph.ctx.currentTime;
    const from = Math.max(this.clicksUntil, now);
    const to = now + CLICK_AHEAD;
    if (to <= from) return;
    for (const click of clicksBetween(this.transport, this.loop, grid.beats, grid.downbeats, from, to)) {
      this.playClick(click);
    }
    this.clicksUntil = to;
  }

  private updateClickTimer(): void {
    const wanted = this.clickOn && this.loaded && this.transport.playing && this.grid !== null;
    if (wanted && !this.clickTimer) this.clickTimer = setInterval(() => this.refillClicks(), CLICK_REFILL_MS);
    if (!wanted && this.clickTimer) {
      clearInterval(this.clickTimer);
      this.clickTimer = null;
    }
  }

  private plainGain(stem: Stem): number {
    return this.mixOnly ? (stem === MIX_SLOT ? 1 : 0) : this.gains[stem];
  }

  private applyGains(): void {
    const graph = this.graph;
    if (!graph) return;
    for (const stem of STEMS) {
      if (stem !== 'guitar') smooth(graph.gains[stem].gain, this.plainGain(stem), graph.ctx, 0.02);
    }
    this.applyGuitar();
  }

  /** The loop's pass at context time `now`. */
  private passAt(now: number): number {
    return this.passBase + wrapsUntil(this.transport, this.loop, now);
  }

  /**
   * The guitar stem's gain: the mixer's value, or with «Повтори за мной» the pass's value now and
   * the changes at the next few wraps, on the audio clock (the pass timer schedules more).
   */
  private applyGuitar(): void {
    const graph = this.graph;
    if (!graph) return;
    const param = graph.gains.guitar.gain;
    const listen = this.repeatGain;
    if (listen === null || this.mixOnly || !loopActive(this.loop)) {
      smooth(param, this.plainGain('guitar'), graph.ctx, 0.02);
      return;
    }
    const now = graph.ctx.currentTime;
    const gain = (pass: number) => (pass % 2 === 0 ? listen : 0);
    const pass = this.passAt(now);
    param.cancelScheduledValues(now);
    param.setTargetAtTime(gain(pass), now, 0.01);
    wrapTimes(this.transport, this.loop, now, 4).forEach((time, k) => param.setTargetAtTime(gain(pass + k + 1), time, 0.005));
  }

  /** A timer just after the loop's next wrap: tells the listeners and schedules the guitar further. */
  private armPassTimer(): void {
    if (this.passTimer) clearTimeout(this.passTimer);
    this.passTimer = null;
    const graph = this.graph;
    if (!graph || !this.loaded) return;
    const now = graph.ctx.currentTime;
    const [next] = wrapTimes(this.transport, this.loop, now, 1);
    if (next === undefined) return;
    this.passTimer = setTimeout(() => this.onPassTimer(), Math.max(10, (next - now) * 1000 + 15));
  }

  private onPassTimer(): void {
    this.passTimer = null;
    const graph = this.graph;
    if (!graph || !this.loaded) return;
    const pass = this.passAt(graph.ctx.currentTime);
    if (pass > this.toldPass) {
      this.toldPass = pass;
      for (const listener of this.wrapListeners) listener(pass);
    }
    this.applyGuitar();
    this.armPassTimer();
  }
}

export const songPlayer = new SongPlayer();

if (import.meta.env.DEV) {
  (window as unknown as { __kvSong: SongPlayer }).__kvSong = songPlayer;
}
