import {
  Doc,
  OpLog,
  StabilityTracker,
  vvGet,
  type Collect,
  type Op,
  type ReplicaId,
  type VersionVector,
} from '@collabpad/crdt';
import {
  ByteCounter,
  CloseCode,
  type ErrorCode,
  type Presence,
  type ServerMessage,
} from '@collabpad/protocol';
import type { Store } from './store';

/** One client connection, as the room sees it. */
export interface Peer {
  readonly replica: ReplicaId;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
  presence?: Presence;
}

export interface RoomOptions {
  replicaLeaseMs: number;
  now?: () => number;
  /** Persist the materialized snapshot after this many accepted ops (also on GC and unload). */
  snapshotEvery?: number;
}

export interface RoomStats {
  docId: string;
  connections: number;
  ops: number;
  vv: VersionVector;
  stable: VersionVector;
  collect: Collect | null;
  members: number;
  evicted: number;
  visible: number;
  tombstones: number;
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
}

/**
 * All live state for one document:
 *  - the op log (complete history, loaded from the store) for anti-entropy;
 *  - a materialized, garbage-collected Doc used to bootstrap new clients with a snapshot;
 *  - connected peers and their presence;
 *  - a StabilityTracker that decides when tombstones may be collected.
 *
 * Ops are persisted before they are forwarded.
 */
export class Room {
  readonly bytes = new ByteCounter();
  private readonly log = new OpLog();
  private readonly doc: Doc;
  private readonly tracker: StabilityTracker;
  private readonly peers = new Map<ReplicaId, Peer>();
  private sinceSnapshot = 0;

  constructor(
    readonly docId: string,
    private readonly store: Store,
    private readonly opts: RoomOptions,
  ) {
    this.log.add(store.loadOps(docId));
    const snapshot = store.loadSnapshot(docId);
    this.doc = snapshot ? Doc.load('#relay', snapshot) : new Doc('#relay');
    this.doc.applyRemote(this.log.since(this.doc.versionVector()));

    const collect = store.loadCollect(docId);
    this.tracker = new StabilityTracker(opts.replicaLeaseMs, {
      members: store.loadMembers(docId),
      collect,
    });
    if (collect) this.doc.collect(collect);
  }

  get size(): number {
    return this.peers.size;
  }

  /**
   * A peer finished its handshake. Evicted replicas, and strangers arriving with offline edits
   * after GC began, are told to rejoin under a new id. A second connection for the same replica
   * replaces the first.
   */
  join(peer: Peer, vv: VersionVector): void {
    if (this.tracker.admit(peer.replica, vv) === 'rejoin') {
      peer.close(CloseCode.Rejoin, 'rejoin required');
      return;
    }
    const existing = this.peers.get(peer.replica);
    if (existing) {
      this.peers.delete(peer.replica);
      existing.close(CloseCode.Replaced, 'replaced by a newer connection');
    }
    this.peers.set(peer.replica, peer);
    for (const other of this.peers.values()) {
      if (other !== peer && other.presence) {
        peer.send({ kind: 'presence', replica: other.replica, presence: other.presence });
      }
    }
    // A client with nothing gets the compact, collected state instead of the full history.
    if (Object.keys(vv).length === 0 && this.log.size > 0) {
      const state = { ...this.doc.snapshot(), log: [], pending: [] };
      peer.send({ kind: 'snapshot', state });
      this.sync(peer, state.vv);
      return;
    }
    this.sync(peer, vv);
  }

  /** Anti-entropy: send what the peer is missing, then our vector so it can send what we miss. */
  sync(peer: Peer, vv: VersionVector): void {
    const missing = this.log.since(vv);
    if (missing.length) peer.send({ kind: 'ops', ops: missing });
    peer.send({ kind: 'sync', vv: this.log.versionVector() });
    peer.send({ kind: 'stable', vv: this.tracker.stable });
    const collect = this.tracker.collect;
    if (collect) peer.send({ kind: 'collect', collect });
    this.observe(peer.replica, vv);
  }

  /** The peer reports what it has integrated (no reply). */
  seen(peer: Peer, vv: VersionVector): void {
    this.observe(peer.replica, vv);
  }

  /** Persist, then forward. Peers may only submit ops they authored. */
  receiveOps(peer: Peer, ops: readonly Op[]): void {
    if (ops.some((op) => op.id.replica !== peer.replica)) {
      this.fail(peer, 'forged-op', 'ops must be authored by the sending replica');
      return;
    }
    const accepted = this.log.add(ops);
    if (accepted.length) {
      const self = peer.replica;
      // The sender has every op it authored.
      this.tracker.observe(self, { [self]: vvGet(this.log.versionVector(), self) }, this.now());
      this.store.appendOps(this.docId, accepted, this.recordsFor([self]));
      this.doc.applyRemote(accepted);
      for (const other of this.peers.values()) {
        if (other !== peer) other.send({ kind: 'ops', ops: accepted });
      }
      this.sinceSnapshot += accepted.length;
      if (this.sinceSnapshot >= (this.opts.snapshotEvery ?? 1000)) this.flush();
    }
    peer.send({ kind: 'ack', vv: this.log.versionVector() });
    if (accepted.length) this.advance([]);
  }

  setPresence(peer: Peer, presence: Presence): void {
    peer.presence = presence;
    this.broadcast(peer, { kind: 'presence', replica: peer.replica, presence });
  }

  leave(peer: Peer): void {
    if (this.peers.get(peer.replica) !== peer) return;
    this.peers.delete(peer.replica);
    this.broadcast(peer, { kind: 'presence-left', replica: peer.replica });
  }

  fail(peer: Peer, code: ErrorCode, message: string, closeCode = 1008): void {
    peer.send({ kind: 'error', code, message });
    peer.close(closeCode, message);
  }

  /** Persist the materialized state (called periodically, after GC, and when the room unloads). */
  flush(): void {
    this.store.saveSnapshot(this.docId, this.doc.snapshot());
    this.sinceSnapshot = 0;
  }

  stats(): RoomStats {
    const records = this.tracker.records();
    const doc = this.doc.stats();
    return {
      docId: this.docId,
      connections: this.peers.size,
      ops: this.log.size,
      vv: this.log.versionVector(),
      stable: this.tracker.stable,
      collect: this.tracker.collect,
      members: records.filter((m) => !m.evicted).length,
      evicted: records.filter((m) => m.evicted).length,
      visible: doc.visible,
      tombstones: doc.tombstones,
      bytesIn: this.bytes.received,
      bytesOut: this.bytes.sent,
      messagesIn: this.bytes.messagesReceived,
      messagesOut: this.bytes.messagesSent,
    };
  }

  // ---------- stability ----------

  private observe(replica: ReplicaId, vv: VersionVector): void {
    this.tracker.observe(replica, vv, this.now());
    this.advance([replica]);
  }

  private advance(changed: ReplicaId[]): void {
    const update = this.tracker.advance(
      this.now(),
      this.log.versionVector(),
      new Set(this.peers.keys()),
    );
    this.store.saveMembers(this.docId, this.recordsFor([...changed, ...update.evicted]));
    if (update.stableChanged) this.broadcastAll({ kind: 'stable', vv: update.stable });
    if (update.collect) {
      this.store.saveCollect(this.docId, update.collect);
      this.doc.collect(update.collect);
      this.flush();
      this.broadcastAll({ kind: 'collect', collect: update.collect });
    }
  }

  private recordsFor(replicas: ReplicaId[]) {
    const wanted = new Set(replicas);
    return this.tracker.records().filter((m) => wanted.has(m.replica));
  }

  private broadcast(from: Peer, msg: ServerMessage): void {
    for (const other of this.peers.values()) if (other !== from) other.send(msg);
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const peer of this.peers.values()) peer.send(msg);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
