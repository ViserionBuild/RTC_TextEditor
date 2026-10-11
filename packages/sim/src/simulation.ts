import {
  Doc,
  OpLog,
  StabilityTracker,
  vvEquals,
  vvGet,
  type Collect,
  type Op,
  type ReplicaId,
  type VersionVector,
} from '@collabpad/crdt';
import { Network, type NetworkOptions, type NetworkStats } from './network';
import { mulberry32 } from './rng';

/** The subset of the real wire protocol that matters for convergence. */
export type Message =
  | { kind: 'hello'; vv: VersionVector }
  | { kind: 'ops'; ops: Op[] }
  /** client → relay: "I have integrated this" (drives stability). */
  | { kind: 'seen'; vv: VersionVector }
  /** relay → client: permission to garbage-collect tombstones. */
  | { kind: 'collect'; collect: Collect };

export interface SimConfig extends Partial<NetworkOptions> {
  readonly seed: number;
  readonly replicas: readonly ReplicaId[];
  /** Online clients re-send HELLO this often (ticks) to repair lost messages. 0 disables. */
  readonly antiEntropyEvery?: number;
  /** Run tombstone garbage collection (StabilityTracker on the relay, Doc.collect on clients). */
  readonly gc?: boolean;
}

export const RELAY = '#relay';

const DEFAULTS: NetworkOptions = { minDelay: 1, maxDelay: 20, duplicateRate: 0.2, dropRate: 0 };

/**
 * Star topology: N clients each hold a full Doc, one relay holds only an OpLog.
 *
 * Protocol (mirrors apps/relay):
 *  - local edit     → client sends OPS to relay (if online)
 *  - relay gets OPS → appends to log, forwards newly accepted ops to every other online client
 *  - (re)connect    → client sends HELLO{vv}; relay answers OPS(missing) + HELLO{relayVV};
 *                     client answers OPS(what the relay is missing)
 *  - with `gc`      → clients report SEEN{vv} after applying ops; the relay's StabilityTracker
 *                     publishes COLLECT rounds and clients purge tombstones
 */
export class Simulation {
  readonly net: Network<Message>;
  readonly relay = new OpLog();
  readonly tracker = new StabilityTracker(Infinity);
  /** Tombstones removed across all replicas (to check GC actually ran). */
  collected = 0;
  private readonly docs = new Map<ReplicaId, Doc>();
  private nextAntiEntropy: number;

  constructor(readonly config: SimConfig) {
    const rand = mulberry32(config.seed);
    this.net = new Network(rand, { ...DEFAULTS, ...config });
    for (const r of config.replicas) {
      this.docs.set(r, new Doc(r));
      // Membership is known up front, so offline replicas hold back GC until they return.
      this.tracker.observe(r, {}, 0);
    }
    this.nextAntiEntropy = this.antiEntropyEvery || Infinity;
  }

  get replicas(): ReplicaId[] {
    return [...this.docs.keys()];
  }

  doc(replica: ReplicaId): Doc {
    const d = this.docs.get(replica);
    if (!d) throw new Error(`unknown replica ${replica}`);
    return d;
  }

  get stats(): NetworkStats {
    return this.net.stats;
  }

  // ---------- user actions ----------

  type(replica: ReplicaId, index: number, text: string): void {
    this.publish(replica, this.doc(replica).insertAt(index, text));
  }

  delete(replica: ReplicaId, index: number, length: number): void {
    this.publish(replica, this.doc(replica).deleteRange(index, length));
  }

  disconnect(replica: ReplicaId): void {
    this.doc(replica); // validate
    this.net.setOnline(replica, false);
  }

  reconnect(replica: ReplicaId): void {
    if (this.net.isOnline(replica)) return;
    this.net.setOnline(replica, true);
    this.hello(replica);
  }

  isOnline(replica: ReplicaId): boolean {
    return this.net.isOnline(replica);
  }

  // ---------- time ----------

  /** Run the network for `ticks` of simulated time. */
  advance(ticks: number): void {
    const until = this.net.now + ticks;
    for (;;) {
      const msgAt = this.net.nextAt() ?? Infinity;
      if (Math.min(msgAt, this.nextAntiEntropy) > until) break;
      if (this.nextAntiEntropy <= msgAt) {
        this.net.now = this.nextAntiEntropy;
        this.nextAntiEntropy += this.antiEntropyEvery;
        for (const r of this.replicas) if (this.net.isOnline(r)) this.hello(r);
      } else {
        this.deliver();
      }
    }
    this.net.now = until;
  }

  /** Deliver everything in flight, then run anti-entropy rounds until online replicas agree. */
  settle(maxRounds = 1000): void {
    for (let round = 0; round < maxRounds; round++) {
      while (this.net.inFlight > 0) this.deliver();
      if (this.onlineInSync()) return;
      for (const r of this.replicas) if (this.net.isOnline(r)) this.hello(r);
    }
    throw new Error(`did not settle within ${maxRounds} anti-entropy rounds`);
  }

  // ---------- assertions ----------

  /**
   * Throws with a diagnostic if any two online replicas (or the relay) disagree, or if their
   * text differs from an oracle that replays the relay's full log without any GC.
   */
  assertConverged(): void {
    const online = this.replicas.filter((r) => this.net.isOnline(r)).map((r) => this.doc(r));
    const first = online[0];
    if (!first) return;
    const relayVV = this.relay.versionVector();
    // With GC, replicas may hold different tombstones; visible elements must still match.
    const hash = (d: Doc) => (this.config.gc ? d.liveHash() : d.fullHash());
    const oracle = new Doc('#oracle');
    oracle.applyRemote(this.relay.since({}));
    for (const d of online) {
      const problems: string[] = [];
      if (d.text() !== oracle.text()) problems.push(`${d.replica} differs from the no-GC oracle`);
      if (hash(d) !== hash(first))
        problems.push(
          `hash ${d.replica}=${JSON.stringify(d.text())} vs ${first.replica}=${JSON.stringify(first.text())}`,
        );
      if (!vvEquals(d.versionVector(), relayVV)) problems.push(`vv ${d.replica} ≠ relay`);
      if (d.pendingCount > 0) problems.push(`${d.replica} has ${d.pendingCount} pending ops`);
      if (problems.length)
        throw new Error(`diverged (seed ${this.config.seed}): ${problems.join('; ')}`);
    }
  }

  // ---------- internals ----------

  private get antiEntropyEvery(): number {
    return this.config.antiEntropyEvery ?? 50;
  }

  private publish(replica: ReplicaId, ops: Op[]): void {
    if (ops.length) this.net.send(replica, RELAY, { kind: 'ops', ops });
  }

  private observe(replica: ReplicaId, vv: VersionVector): void {
    if (!this.config.gc) return;
    this.tracker.observe(replica, vv, this.net.now);
    const online = new Set(this.replicas.filter((r) => this.net.isOnline(r)));
    const { collect } = this.tracker.advance(this.net.now, this.relay.versionVector(), online);
    if (collect) for (const r of online) this.net.send(RELAY, r, { kind: 'collect', collect });
  }

  private hello(replica: ReplicaId): void {
    this.net.send(replica, RELAY, { kind: 'hello', vv: this.doc(replica).versionVector() });
  }

  private deliver(): void {
    const env = this.net.deliverNext();
    if (!env) return;
    const { from, to, msg } = env;
    if (to === RELAY) {
      if (msg.kind === 'hello') {
        const missing = this.relay.since(msg.vv);
        if (missing.length) this.net.send(RELAY, from, { kind: 'ops', ops: missing });
        this.net.send(RELAY, from, { kind: 'hello', vv: this.relay.versionVector() });
        const latest = this.tracker.collect;
        if (this.config.gc && latest)
          this.net.send(RELAY, from, { kind: 'collect', collect: latest });
        this.observe(from, msg.vv);
      } else if (msg.kind === 'seen') {
        this.observe(from, msg.vv);
      } else if (msg.kind === 'ops') {
        const accepted = this.relay.add(msg.ops);
        if (accepted.length === 0) return;
        for (const r of this.replicas)
          if (r !== from && this.net.isOnline(r))
            this.net.send(RELAY, r, { kind: 'ops', ops: accepted });
        // The sender has its own ops, as far as the relay has stored them.
        this.observe(from, { [from]: vvGet(this.relay.versionVector(), from) });
      }
    } else {
      const doc = this.doc(to);
      if (msg.kind === 'hello') {
        const missing = doc.opsSince(msg.vv);
        if (missing.length) this.net.send(to, RELAY, { kind: 'ops', ops: missing });
      } else if (msg.kind === 'ops') {
        doc.applyRemote(msg.ops);
        if (this.config.gc) this.net.send(to, RELAY, { kind: 'seen', vv: doc.versionVector() });
      } else if (msg.kind === 'collect') {
        this.collected += doc.collect(msg.collect);
      }
    }
  }

  private onlineInSync(): boolean {
    const relayVV = this.relay.versionVector();
    return this.replicas
      .filter((r) => this.net.isOnline(r))
      .every((r) => {
        const d = this.doc(r);
        return d.pendingCount === 0 && vvEquals(d.versionVector(), relayVV);
      });
  }
}
