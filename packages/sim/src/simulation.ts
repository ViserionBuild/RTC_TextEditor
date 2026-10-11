import { Doc, OpLog, vvEquals, type Op, type ReplicaId, type VersionVector } from '@collabpad/crdt';
import { Network, type NetworkOptions, type NetworkStats } from './network';
import { mulberry32 } from './rng';

/** The subset of the real wire protocol that matters for convergence. */
export type Message = { kind: 'hello'; vv: VersionVector } | { kind: 'ops'; ops: Op[] };

export interface SimConfig extends Partial<NetworkOptions> {
  readonly seed: number;
  readonly replicas: readonly ReplicaId[];
  /** Online clients re-send HELLO this often (ticks) to repair lost messages. 0 disables. */
  readonly antiEntropyEvery?: number;
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
 */
export class Simulation {
  readonly net: Network<Message>;
  readonly relay = new OpLog();
  private readonly docs = new Map<ReplicaId, Doc>();
  private nextAntiEntropy: number;

  constructor(readonly config: SimConfig) {
    const rand = mulberry32(config.seed);
    this.net = new Network(rand, { ...DEFAULTS, ...config });
    for (const r of config.replicas) this.docs.set(r, new Doc(r));
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

  /** Throws with a diagnostic if any two online replicas (or the relay) disagree. */
  assertConverged(): void {
    const online = this.replicas.filter((r) => this.net.isOnline(r)).map((r) => this.doc(r));
    const first = online[0];
    if (!first) return;
    const relayVV = this.relay.versionVector();
    for (const d of online) {
      const problems: string[] = [];
      if (d.fullHash() !== first.fullHash())
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
      } else {
        const accepted = this.relay.add(msg.ops);
        if (accepted.length === 0) return;
        for (const r of this.replicas)
          if (r !== from && this.net.isOnline(r))
            this.net.send(RELAY, r, { kind: 'ops', ops: accepted });
      }
    } else {
      const doc = this.doc(to);
      if (msg.kind === 'hello') {
        const missing = doc.opsSince(msg.vv);
        if (missing.length) this.net.send(to, RELAY, { kind: 'ops', ops: missing });
      } else {
        doc.applyRemote(msg.ops);
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
