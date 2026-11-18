import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnalysis } from '../analysis';
import { buildNativeGraph, createNativeContext, STREAM_PROCESSOR } from './graph';
import type { EngineState } from './protocol';

interface FakeNode {
  kind: string;
  connections: unknown[];
  connect(to: unknown): unknown;
  gain: { value: number };
}

/** Just enough of an AudioContext to build the graph and see how it is wired. */
function fakeContext() {
  const nodes: FakeNode[] = [];
  const make = (kind: string): FakeNode => {
    const node: FakeNode = {
      kind,
      connections: [],
      gain: { value: 1 },
      connect(to) {
        this.connections.push(to);
        return to;
      },
    };
    nodes.push(node);
    return node;
  };
  const destination = make('destination');
  const ctx = {
    sampleRate: 48000,
    destination,
    createChannelSplitter: () => make('splitter'),
    createGain: () => make('gain'),
    createAnalyser: () => ({ ...make('analyser'), fftSize: 0, smoothingTimeConstant: 0 }),
    createBiquadFilter: () => Object.assign(make('biquad'), { type: 'lowpass', frequency: { value: 350 }, Q: { value: 1 } }),
  };
  return { ctx: ctx as unknown as AudioContext, nodes, destination };
}

class FakeWorkletNode {
  static created: FakeWorkletNode[] = [];
  readonly connections: unknown[] = [];
  readonly port = { postMessage: vi.fn() };
  constructor(
    readonly ctx: unknown,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    FakeWorkletNode.created.push(this);
  }
  connect(to: unknown): unknown {
    this.connections.push(to);
    return to;
  }
}

const engineState = (over: Partial<EngineState> = {}): EngineState => ({
  type: 'state',
  protocol: 1,
  status: 'running',
  devices: [],
  device: null,
  sampleRate: 48000,
  buffer: 128,
  latencyMs: null,
  amp: { state: 'ready' },
  error: null,
  ...over,
});

beforeEach(() => {
  FakeWorkletNode.created = [];
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the analysis context of the native path', () => {
  it('creates the analysis context at the engine rate', () => {
    const made = fakeContext().ctx;
    const factory = vi.fn((_options: AudioContextOptions) => made);
    expect(createNativeContext(engineState({ sampleRate: 48000 }), factory)).toBe(made);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0]).toMatchObject({ sampleRate: 48000 });

    createNativeContext(engineState({ sampleRate: 44100 }), factory);
    expect(factory.mock.calls[1]![0]).toMatchObject({ sampleRate: 44100 });
  });

  it('asks for the relaxed playback latency: this context makes no sound', () => {
    const factory = vi.fn((_options: AudioContextOptions) => fakeContext().ctx);
    createNativeContext(engineState(), factory);
    expect(factory.mock.calls[0]![0]).toMatchObject({ latencyHint: 'playback' });
  });

  it('is analysis only: the stream feeds the splitter, and only a muted gain reaches the speakers', () => {
    const { ctx, nodes, destination } = fakeContext();
    const graph = buildNativeGraph(ctx);

    const stream = FakeWorkletNode.created.find((n) => n.name === STREAM_PROCESSOR)!;
    expect(STREAM_PROCESSOR).toBe('kv-stream');
    expect(stream.options).toMatchObject({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    expect(stream.connections).toContain(graph.splitter);
    expect(graph.stream).toBe(stream);

    // The meter, the tuner and «Проверь меня» read the same nodes as in the browser path.
    expect(graph.splitter).toBeDefined();
    expect(graph.anL).toBeDefined();
    expect(graph.anR).toBeDefined();
    expect(graph.anMono).toBeDefined();
    expect(graph.anSpec).toBeDefined();
    expect(graph.gate).toBeDefined();

    const toSpeakers = [...nodes, ...FakeWorkletNode.created].filter((n) => n.connections.includes(destination));
    expect(toSpeakers).toHaveLength(1);
    expect(toSpeakers[0]).toBe(graph.keepAlive);
    expect((graph.keepAlive as unknown as FakeNode).gain.value).toBe(0);
  });
});

describe('buildAnalysis', () => {
  it('taps L, R and the picked mono channel, and the gated guitar for the spectrum', () => {
    const { ctx } = fakeContext();
    const an = buildAnalysis(ctx);
    const gate = FakeWorkletNode.created.find((n) => n.name === 'kv-gate')!;
    expect(gate.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    expect(an.gate).toBe(gate);
    expect(gate.connections).toContain(an.anSpec);
    const connectedFrom = (from: unknown) => (from as FakeNode).connections;
    expect(connectedFrom(an.splitter)).toEqual(expect.arrayContaining([an.anL, an.anR, an.gainL, an.gainR]));
    expect(connectedFrom(an.gainL)).toContain(an.mono);
    expect(connectedFrom(an.gainR)).toContain(an.mono);
    // The pitch analyser hears the raw guitar; the gate hears it trimmed («Подстроить под мою
    // гитару»), through the hum filter.
    expect(connectedFrom(an.mono)).toEqual(expect.arrayContaining([an.anMono, an.trim]));
    expect(connectedFrom(an.mono)).not.toContain(an.gate);
    expect(connectedFrom(an.mono)).not.toContain(an.hum.input);
    // The trimmed input also feeds the mains detector's tap, before the hum filter.
    expect(connectedFrom(an.trim)).toEqual([an.hum.input, an.humTap]);
    expect(connectedFrom(an.hum.output)).toContain(an.gate);
  });

  it('has the hum filter: six 2 Hz wide notches at 50 Hz and its harmonics, mixed out at first', () => {
    const { ctx, nodes } = fakeContext();
    buildAnalysis(ctx);
    const notches = nodes.filter((n) => n.kind === 'biquad') as unknown as BiquadFilterNode[];
    expect(notches.map((n) => [n.type, n.frequency.value, n.Q.value])).toEqual([
      ['notch', 50, 25],
      ['notch', 100, 50],
      ['notch', 150, 75],
      ['notch', 200, 100],
      ['notch', 250, 125],
      ['notch', 300, 150],
    ]);
  });
});
