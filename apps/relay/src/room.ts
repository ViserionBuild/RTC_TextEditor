import {
  OpLog,
  vvEquals,
  vvGet,
  vvMerge,
  vvMin,
  type Op,
  type ReplicaId,
  type VersionVector,
} from '@collabpad/crdt';
import {
  ByteCounter,
  type ErrorCode,
  type Presence,
  type ServerMessage,
} from '@collabpad/protocol';
import type { ReplicaAck, Store } from './store';

/** One client connection, as the room sees it. */
export interface Peer {
  readonly replica: ReplicaId;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
  presence?: Presence;
}

export interface RoomStats {
  docId: string;
  connections: number;
  ops: number;
  vv: VersionVector;
  stable: VersionVector;
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
}

/**
 * All live state for one document: the op log (loaded from the store), connected peers,
 * presence, and the per-replica vectors used to compute causal stability.
 *
 * The relay never interprets ops. It persists them, then forwards them.
 */
export class Room {
  readonly bytes = new ByteCounter();
  private readonly log = new OpLog();
  private readonly peers = new Map<ReplicaId, Peer>();
  private readonly acks = new Map<ReplicaId, ReplicaAck>();
  private stable: VersionVector = {};

  constructor(
    readonly docId: string,
    private readonly store: Store,
    private readonly opts: { replicaLeaseMs: number; now?: () => number },
  ) {
    this.log.add(store.loadOps(docId));
    for (const ack of store.loadAcks(docId)) this.acks.set(ack.replica, ack);
    this.stable = this.computeStable();
  }

  get size(): number {
    return this.peers.size;
  }

  /** A peer finished its handshake. A second connection for the same replica replaces the first. */
  join(peer: Peer, vv: VersionVector): void {
    const existing = this.peers.get(peer.replica);
    if (existing) {
      this.peers.delete(peer.replica);
      existing.close(4409, 'replaced by a newer connection');
    }
    this.peers.set(peer.replica, peer);
    for (const other of this.peers.values()) {
      if (other !== peer && other.presence) {
        peer.send({ kind: 'presence', replica: other.replica, presence: other.presence });
      }
    }
    this.sync(peer, vv);
  }

  /** Anti-entropy: send what the peer is missing, then our vector so it can send what we miss. */
  sync(peer: Peer, vv: VersionVector): void {
    const missing = this.log.since(vv);
    if (missing.length) peer.send({ kind: 'ops', ops: missing });
    peer.send({ kind: 'sync', vv: this.log.versionVector() });
    peer.send({ kind: 'stable', vv: this.stable });
    this.recordAck(peer.replica, vv);
  }

  /** Persist, then forward. Peers may only submit ops they authored. */
  receiveOps(peer: Peer, ops: readonly Op[]): void {
    if (ops.some((op) => op.id.replica !== peer.replica)) {
      this.fail(peer, 'forged-op', 'ops must be authored by the sending replica');
      return;
    }
    const accepted = this.log.add(ops);
    if (accepted.length) {
      // The sender has every op it authored, so its known vector advances too.
      const self = peer.replica;
      const ack = this.ackFor(self, { [self]: vvGet(this.log.versionVector(), self) });
      this.store.appendOps(this.docId, accepted, ack);
      this.acks.set(self, ack);
      for (const other of this.peers.values()) {
        if (other !== peer) other.send({ kind: 'ops', ops: accepted });
      }
      this.updateStable();
    }
    peer.send({ kind: 'ack', vv: this.log.versionVector() });
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

  stats(): RoomStats {
    return {
      docId: this.docId,
      connections: this.peers.size,
      ops: this.log.size,
      vv: this.log.versionVector(),
      stable: this.stable,
      bytesIn: this.bytes.received,
      bytesOut: this.bytes.sent,
      messagesIn: this.bytes.messagesReceived,
      messagesOut: this.bytes.messagesSent,
    };
  }

  // ---------- stability ----------

  private recordAck(replica: ReplicaId, vv: VersionVector): void {
    const ack = this.ackFor(replica, vv);
    this.acks.set(replica, ack);
    this.store.saveAck(this.docId, ack);
    this.updateStable();
  }

  private ackFor(replica: ReplicaId, vv: VersionVector): ReplicaAck {
    const prev = this.acks.get(replica)?.vv ?? {};
    return { replica, vv: vvMerge(prev, vv), lastSeen: this.now() };
  }

  /**
   * Ops at or below the pointwise minimum of every live member's vector have been seen by
   * everyone. Kept monotonic: a brand-new replica (empty vector) cannot have issued ops that
   * reference anything it never saw, so it must not drag stability backwards. A replica that
   * returns after its lease expired is the exception; Phase 5 makes it rejoin from a snapshot.
   */
  private computeStable(): VersionVector {
    const cutoff = this.now() - this.opts.replicaLeaseMs;
    const live = [...this.acks.values()].filter((a) => a.lastSeen >= cutoff).map((a) => a.vv);
    return vvMerge(this.stable, vvMin(live));
  }

  private updateStable(): void {
    const next = this.computeStable();
    if (vvEquals(next, this.stable)) return;
    this.stable = next;
    for (const peer of this.peers.values()) peer.send({ kind: 'stable', vv: next });
  }

  private broadcast(from: Peer, msg: ServerMessage): void {
    for (const other of this.peers.values()) if (other !== from) other.send(msg);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
