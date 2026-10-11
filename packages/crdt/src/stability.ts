import type { Collect } from './doc';
import type { ReplicaId } from './ids';
import { vvDominates, vvEquals, vvGet, vvMerge, vvMin, type VersionVector } from './vv';

/** What the relay knows about one replica of a document. */
export interface MemberRecord {
  readonly replica: ReplicaId;
  /** Everything this replica has reported integrating (its own ops included). */
  vv: VersionVector;
  lastSeen: number;
  /** Unseen for longer than the lease: no longer holds back GC, must rejoin to edit again. */
  evicted: boolean;
}

export interface TrackerUpdate {
  /** Pointwise minimum over live members: ops at or below it are on every live replica. */
  readonly stable: VersionVector;
  readonly stableChanged: boolean;
  /** A newly published GC permission, if this step completed a round. */
  readonly collect: Collect | null;
  readonly evicted: ReplicaId[];
}

/**
 * Decides when tombstones may be garbage-collected, in two rounds.
 *
 * Round 1 fixes a frontier S = the current stable vector: every live replica has seen S.
 * For each replica R we then record C[R] = R's own seq at the moment it first reported having
 * seen S. R's ops numbered above C[R] were created after R saw S, so they never reference an
 * element S deleted and their Lamport stamps exceed every stamp in S.
 *
 * Round 2 waits until everyone has seen C. From then on, every op a replica has not integrated
 * yet was created after its author saw S, so tombstones inserted and deleted within S can be
 * purged (Doc.collect also checks the RGA neighbour condition).
 *
 * Membership: a replica unseen for `leaseMs` is evicted so it cannot block GC forever. It, and
 * any unknown replica that arrives with offline edits after a GC round, never saw what was
 * collected and must rejoin under a new id (see rebaseUnacked).
 */
export class StabilityTracker {
  private readonly members = new Map<ReplicaId, MemberRecord>();
  private candidate: { S: VersionVector; C: Map<ReplicaId, number> } | null = null;
  private published: Collect | null;
  private stableVV: VersionVector = {};

  constructor(
    private readonly leaseMs: number,
    init: { members?: readonly MemberRecord[]; collect?: Collect | null } = {},
  ) {
    for (const m of init.members ?? []) this.members.set(m.replica, { ...m, vv: { ...m.vv } });
    this.published = init.collect ?? null;
  }

  get stable(): VersionVector {
    return this.stableVV;
  }

  /** The latest GC permission (resent to replicas when they connect). */
  get collect(): Collect | null {
    return this.published;
  }

  records(): MemberRecord[] {
    return [...this.members.values()].map((m) => ({ ...m, vv: { ...m.vv } }));
  }

  isEvicted(replica: ReplicaId): boolean {
    return this.members.get(replica)?.evicted ?? false;
  }

  /**
   * May this replica connect with this vector? Evicted replicas, and unknown replicas that
   * already authored ops (offline) after GC has started, must rejoin under a new id.
   */
  admit(replica: ReplicaId, vv: VersionVector): 'ok' | 'rejoin' {
    const m = this.members.get(replica);
    if (m?.evicted) return 'rejoin';
    if (!m && this.published && vvGet(vv, replica) > 0) return 'rejoin';
    return 'ok';
  }

  /** Record what a replica reports having (hello / sync / seen), or its own new ops. */
  observe(replica: ReplicaId, vv: VersionVector, now: number): void {
    let m = this.members.get(replica);
    if (!m) this.members.set(replica, (m = { replica, vv: {}, lastSeen: now, evicted: false }));
    if (m.evicted) return;
    m.vv = vvMerge(m.vv, vv);
    m.lastSeen = Math.max(m.lastSeen, now);
    this.recordCandidate(m);
  }

  /**
   * Evict stale members, recompute stability and advance the GC rounds.
   * `authored` is the relay's log vector (every op it has stored, per author).
   */
  advance(now: number, authored: VersionVector, connected: ReadonlySet<ReplicaId>): TrackerUpdate {
    const evicted: ReplicaId[] = [];
    for (const m of this.members.values()) {
      if (!m.evicted && !connected.has(m.replica) && now - m.lastSeen > this.leaseMs) {
        m.evicted = true;
        evicted.push(m.replica);
      }
    }

    const live = [...this.members.values()].filter((m) => !m.evicted);
    const stable = vvMin(live.map((m) => m.vv));
    const stableChanged = !vvEquals(stable, this.stableVV);
    this.stableVV = stable;

    let collect: Collect | null = null;
    if (this.candidate) {
      for (const m of live) this.recordCandidate(m);
      const { S, C } = this.candidate;
      if (live.every((m) => C.has(m.replica))) {
        const requires: VersionVector = {};
        for (const r of new Set([...Object.keys(authored), ...C.keys()])) {
          const member = this.members.get(r);
          // Live members: their own seq when they saw S. Others can no longer author ops,
          // so everything of theirs the relay stored must be delivered first.
          const seq = member && !member.evicted && C.has(r) ? C.get(r)! : vvGet(authored, r);
          if (seq > 0) requires[r] = seq;
        }
        if (vvDominates(stable, requires)) {
          collect = this.published = { vv: S, requires };
          this.candidate = null;
        }
      }
    }
    if (!this.candidate && live.length > 0 && !vvDominates(this.published?.vv ?? {}, stable)) {
      this.candidate = { S: stable, C: new Map() };
      for (const m of live) this.recordCandidate(m);
    }
    return { stable, stableChanged, collect, evicted };
  }

  private recordCandidate(m: MemberRecord): void {
    const c = this.candidate;
    if (c && !m.evicted && !c.C.has(m.replica) && vvDominates(m.vv, c.S)) {
      c.C.set(m.replica, vvGet(m.vv, m.replica));
    }
  }
}
