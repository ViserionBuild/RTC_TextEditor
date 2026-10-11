import {
  vvGet,
  vvMerge,
  type Doc,
  type Op,
  type ReplicaId,
  type VersionVector,
} from '@collabpad/crdt';
import {
  ByteCounter,
  CloseCode,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type Presence,
  type ServerMessage,
} from '@collabpad/protocol';
import { Emitter } from './emitter';

export type Status = 'connecting' | 'online' | 'offline';

export interface SyncClientOptions {
  /** Relay WebSocket endpoint, e.g. ws://localhost:8787/ws */
  readonly url: string;
  readonly docId: string;
  readonly doc: Doc;
  /** Periodic anti-entropy (also reports our vector for tombstone stability). */
  readonly syncIntervalMs?: number;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  readonly WebSocket?: typeof WebSocket;
  readonly random?: () => number;
}

type Events = {
  status: [Status];
  /** Remote ops that were applied to the doc, in application order. */
  remote: [Op[]];
  /** Number of local ops not yet durably stored by the relay. */
  pending: [number];
  presence: [ReplicaId, Presence | null];
  stable: [VersionVector];
  fatal: [string];
};

/**
 * Keeps a Doc in sync with the relay.
 *
 * Handshake: HELLO{vv} → relay sends missing ops and SYNC{relayVV} → we send the ops the relay
 * lacks. Live edits go out immediately; anything lost on the way is repaired by the next SYNC.
 * Local ops above the relay's ACKed vector are "pending" and are re-sent after reconnecting.
 */
export class SyncClient extends Emitter<Events> {
  readonly bytes = new ByteCounter();
  private ws: WebSocket | null = null;
  private serverVV: VersionVector = {};
  private presence: Presence | null = null;
  private readonly peers = new Map<ReplicaId, Presence>();
  private wanted = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private currentStatus: Status = 'offline';

  constructor(private readonly opts: SyncClientOptions) {
    super();
  }

  get doc(): Doc {
    return this.opts.doc;
  }

  get status(): Status {
    return this.currentStatus;
  }

  get pending(): number {
    const self = this.doc.replica;
    return vvGet(this.doc.versionVector(), self) - vvGet(this.serverVV, self);
  }

  get peerPresence(): ReadonlyMap<ReplicaId, Presence> {
    return this.peers;
  }

  connect(): void {
    this.wanted = true;
    if (this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.setStatus('connecting');

    const WS = this.opts.WebSocket ?? globalThis.WebSocket;
    const ws = new WS(`${this.opts.url}?doc=${encodeURIComponent(this.opts.docId)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ kind: 'hello', replica: this.doc.replica, vv: this.doc.versionVector() });
      if (this.presence) this.send({ kind: 'presence', presence: this.presence });
      this.syncTimer = setInterval(
        () => this.send({ kind: 'sync', vv: this.doc.versionVector() }),
        this.opts.syncIntervalMs ?? 30_000,
      );
    };
    ws.onmessage = (ev) =>
      this.receive(decodeServerMessage(this.bytes.countReceived(String(ev.data))));
    ws.onclose = (ev) => this.closed(ws, ev.code, ev.reason);
  }

  /** Close the connection and stay offline until connect() is called. */
  disconnect(): void {
    this.wanted = false;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.teardown();
  }

  /** Send ops produced by local edits. Safe to call while offline. */
  submit(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    this.send({ kind: 'ops', ops: [...ops] });
    this.emit('pending', this.pending);
  }

  setPresence(presence: Presence): void {
    this.presence = presence;
    this.send({ kind: 'presence', presence });
  }

  // ---------- internals ----------

  private receive(msg: ServerMessage): void {
    switch (msg.kind) {
      case 'ops': {
        const applied = this.doc.applyRemote(msg.ops);
        if (applied.length) this.emit('remote', applied);
        break;
      }
      case 'sync': {
        this.serverVV = vvMerge(this.serverVV, msg.vv);
        const own = this.doc.replica;
        const missing = this.doc.opsSince(msg.vv).filter((op) => op.id.replica === own);
        if (missing.length) this.send({ kind: 'ops', ops: missing });
        this.attempt = 0;
        this.setStatus('online');
        this.emit('pending', this.pending);
        break;
      }
      case 'ack':
        this.serverVV = vvMerge(this.serverVV, msg.vv);
        this.emit('pending', this.pending);
        break;
      case 'stable':
        this.emit('stable', msg.vv);
        break;
      case 'presence':
        this.peers.set(msg.replica, msg.presence);
        this.emit('presence', msg.replica, msg.presence);
        break;
      case 'presence-left':
        this.peers.delete(msg.replica);
        this.emit('presence', msg.replica, null);
        break;
      case 'error':
        // The relay closes the socket after errors; reconnect logic handles the rest.
        break;
    }
  }

  private closed(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.teardown();
    if (code === CloseCode.UnknownDoc || code === CloseCode.Replaced) {
      this.wanted = false;
      this.emit('fatal', reason || `closed with ${code}`);
      return;
    }
    if (!this.wanted) return;
    const initial = this.opts.backoffInitialMs ?? 500;
    const cap = this.opts.backoffMaxMs ?? 10_000;
    const base = Math.min(cap, initial * 2 ** this.attempt++);
    const jitter = 0.5 + (this.opts.random ?? Math.random)() * 0.5;
    this.reconnectTimer = setTimeout(() => this.connect(), base * jitter);
  }

  private teardown(): void {
    clearInterval(this.syncTimer);
    this.ws = null;
    for (const replica of this.peers.keys()) this.emit('presence', replica, null);
    this.peers.clear();
    this.setStatus('offline');
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === 1) this.ws.send(this.bytes.countSent(encode(msg)));
  }

  private setStatus(status: Status): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.emit('status', status);
  }
}
