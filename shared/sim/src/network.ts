import { randInt, type Rand } from './rng';

export type NodeId = string;

export interface NetworkOptions {
  /** Per-message latency range, in simulated ticks. Independent delays reorder messages. */
  readonly minDelay: number;
  readonly maxDelay: number;
  /** Probability that a message is delivered more than once (1–3 extra copies). */
  readonly duplicateRate: number;
  /** Probability that a message is silently lost. */
  readonly dropRate: number;
}

export interface Envelope<M> {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly msg: M;
}

export interface NetworkStats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  bytes: number;
}

interface Scheduled<M> extends Envelope<M> {
  readonly at: number;
  readonly order: number;
}

const encoder = new TextEncoder();

/**
 * Discrete-event network with seeded latency, duplication, loss and node outages.
 * A node that is offline neither sends nor receives: in-flight messages to or from it are
 * dropped on delivery, like a closed socket.
 */
export class Network<M> {
  now = 0;
  readonly stats: NetworkStats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, bytes: 0 };
  private queue: Scheduled<M>[] = [];
  private readonly offline = new Set<NodeId>();
  private order = 0;

  constructor(
    private readonly rand: Rand,
    private readonly opts: NetworkOptions,
  ) {}

  setOnline(node: NodeId, online: boolean): void {
    if (online) this.offline.delete(node);
    else this.offline.add(node);
  }

  isOnline(node: NodeId): boolean {
    return !this.offline.has(node);
  }

  send(from: NodeId, to: NodeId, msg: M): void {
    if (!this.isOnline(from) || !this.isOnline(to)) return;
    this.stats.sent++;
    this.stats.bytes += encoder.encode(JSON.stringify(msg)).length;
    if (this.rand() < this.opts.dropRate) {
      this.stats.dropped++;
      return;
    }
    const copies = this.rand() < this.opts.duplicateRate ? 1 + randInt(this.rand, 1, 3) : 1;
    this.stats.duplicated += copies - 1;
    for (let i = 0; i < copies; i++) {
      const at = this.now + randInt(this.rand, this.opts.minDelay, this.opts.maxDelay);
      this.queue.push({ from, to, msg, at, order: this.order++ });
    }
    this.queue.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  /** Time of the next scheduled delivery, or undefined when nothing is in flight. */
  nextAt(): number | undefined {
    return this.queue[0]?.at;
  }

  /** Pop the next message, advancing the clock. Returns null if it was lost to an outage. */
  deliverNext(): Envelope<M> | null | undefined {
    const next = this.queue.shift();
    if (!next) return undefined;
    this.now = Math.max(this.now, next.at);
    if (!this.isOnline(next.from) || !this.isOnline(next.to)) {
      this.stats.dropped++;
      return null;
    }
    this.stats.delivered++;
    return next;
  }

  get inFlight(): number {
    return this.queue.length;
  }
}
