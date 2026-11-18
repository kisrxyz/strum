// Stand-ins for the engine's side of the conversation, for tests: a WebSocket driven by hand and
// the engine's messages. Not part of the app.
import type { SocketLike } from './client';
import type { ClientMessage, EngineState, EngineStats } from './protocol';

/** A WebSocket the test drives by hand. */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // --- the test plays the engine ---
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  say(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  binary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  get messages(): ClientMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMessage);
  }
  get types(): string[] {
    return this.messages.map((m) => m.type);
  }
}

export const engineState = (over: Partial<EngineState> = {}): EngineState => ({
  type: 'state',
  protocol: 1,
  status: 'running',
  devices: ['M-Track Solo and Duo ASIO', 'ASIO4ALL v2'],
  device: 'M-Track Solo and Duo ASIO',
  sampleRate: 48000,
  buffer: 64,
  latencyMs: { input: 8.2, output: 5 },
  amp: { state: 'ready' },
  error: null,
  ...over,
});

export const engineStats = (over: Partial<EngineStats> = {}): EngineStats => ({
  type: 'stats',
  xruns: 0,
  budgetMs: 1.33,
  callbackMs: { p50: 0.9, p99: 1.2, max: 2 },
  outPeakDb: -9,
  outRmsDb: -18,
  ...over,
});

