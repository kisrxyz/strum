// The WebSocket to the native guitar engine (kv_guitar): connects, says hello, hands on what
// comes in (state, stats, audio frames, requests for user files) and reconnects by itself.
// What to do about it all is the session's business (`session.ts`).
import {
  decodeFrame,
  parseEngineMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type EngineState,
  type EngineStats,
} from './protocol';

/** One try to reach the engine (socket up and the first `state` read) gets this long. */
export const HANDSHAKE_TIMEOUT_MS = 2500;
/** Pause between tries while the engine cannot be reached. */
export const RECONNECT_MS = 1000;

const OPEN = 1;

/** The part of `WebSocket` we use, so tests can stand in for it. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export type SocketFactory = (url: string) => SocketLike;

const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/**
 * Keeps one WebSocket to the engine alive for as long as it is wanted (`connect()` until `close()`).
 *
 * `connect()` settles on the first try only: with the engine's first `state`, or an error. After
 * that the link goes on trying by itself, one try a second, and says so through `onClose` (an
 * established connection dropped) and `onReconnect` (a later connection got its first `state`).
 */
export class NativeLink {
  /** Every `state` message, the first of a connection included. */
  onState: ((state: EngineState) => void) | null = null;
  onStats: ((stats: EngineStats) => void) | null = null;
  /** One audio frame; `left` and `right` are fresh arrays the receiver may transfer away. */
  onFrame: ((frame0: number, left: Float32Array, right: Float32Array) => void) | null = null;
  /** What the card played, while `record` is on («Запись»); the same clock as `onFrame`. */
  onOutput: ((frame0: number, left: Float32Array, right: Float32Array) => void) | null = null;
  /** The engine names a `user:` file it does not have. */
  onNeedAsset: ((id: string) => void) | null = null;
  /** A connection that had been established dropped (not called for failed tries or for `close()`). */
  onClose: (() => void) | null = null;
  /** Called after `onState` for the first state of a connection that is not the one `connect()` waited for. */
  onReconnect: ((state: EngineState) => void) | null = null;

  private url = '';
  private wanted = false;
  private socket: SocketLike | null = null;
  /** The current socket has delivered its first `state`. */
  private handshaken = false;
  private pending: { resolve: (state: EngineState) => void; reject: (error: Error) => void } | null = null;
  private attemptTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly createSocket: SocketFactory = browserSocket) {}

  /** The socket is open and the engine has said who it is. */
  get connected(): boolean {
    return this.handshaken && this.socket?.readyState === OPEN;
  }

  connect(url: string): Promise<EngineState> {
    this.release(new Error('replaced by a new connection')); // never shown: the session words it
    this.url = url;
    this.wanted = true;
    const result = new Promise<EngineState>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    this.attempt();
    return result;
  }

  /** False when the message could not go out (no open socket): the caller decides what that means. */
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  /** Stops for good: no more tries, no `onClose`. */
  close(): void {
    this.wanted = false;
    this.release(new Error('connection closed')); // never shown
  }

  private attempt(): void {
    if (!this.wanted) return;
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.failed();
      return;
    }
    this.socket = socket;
    this.handshaken = false;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.socket === socket) socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION } satisfies ClientMessage));
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => undefined; // a `close` always follows
    socket.onclose = () => {
      if (this.socket === socket) this.dropped();
    };
    this.attemptTimer = setTimeout(() => {
      if (this.socket !== socket || this.handshaken) return;
      this.detach(true);
      this.failed();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private receive(data: unknown): void {
    if (typeof data === 'string') {
      const message = parseEngineMessage(data);
      if (!message) return;
      if (message.type === 'state') this.stateArrived(message);
      else if (message.type === 'stats') this.onStats?.(message);
      else this.onNeedAsset?.(message.id);
    } else if (data instanceof ArrayBuffer && this.handshaken) {
      const frame = decodeFrame(data);
      if (!frame) return;
      if (frame.kind === 'input') this.onFrame?.(frame.frame0, frame.left, frame.right);
      else this.onOutput?.(frame.frame0, frame.left, frame.right);
    }
  }

  private stateArrived(state: EngineState): void {
    const first = !this.handshaken;
    if (first) {
      this.handshaken = true;
      clearTimeout(this.attemptTimer);
    }
    this.onState?.(state);
    if (!first) return;
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.resolve(state);
    } else {
      this.onReconnect?.(state);
    }
  }

  /** The socket closed on its own (the engine went away, or the network did). */
  private dropped(): void {
    const wasConnected = this.handshaken;
    this.detach(false);
    if (wasConnected) this.onClose?.();
    this.failed();
  }

  /** This try is over without a connection: tell whoever waits, and try again soon. */
  private failed(): void {
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.reject(new Error('no link to the guitar engine')); // never shown
    }
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.attempt(), RECONNECT_MS);
  }

  /** Lets go of the socket without telling anyone. Its late events are ignored from now on. */
  private detach(closeSocket: boolean): void {
    clearTimeout(this.attemptTimer);
    const socket = this.socket;
    this.socket = null;
    this.handshaken = false;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    if (closeSocket) {
      try {
        socket.close(1000);
      } catch {
        /* already gone */
      }
    }
  }

  /** Drops the socket and the timers, and fails a `connect()` that is still waiting. */
  private release(reason: Error): void {
    clearTimeout(this.retryTimer);
    this.detach(true);
    const pending = this.pending;
    this.pending = null;
    pending?.reject(reason);
  }
}
