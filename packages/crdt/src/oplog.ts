import { idKey, type ReplicaId } from './ids';
import type { Op } from './ops';
import { vvGet, type VersionVector } from './vv';

/**
 * Append-only, per-replica op log used by the relay. It does not interpret ops; it only keeps
 * each replica's ops contiguous by seq, drops duplicates, and answers anti-entropy queries.
 * Ops that arrive ahead of a gap are held until the gap is filled.
 */
export class OpLog {
  private readonly byReplica = new Map<ReplicaId, Op[]>();
  private readonly early = new Map<string, Op>();

  /** Add ops in any order. Returns the ops that became part of the log, per-replica in seq order. */
  add(ops: Iterable<Op>): Op[] {
    const touched = new Set<ReplicaId>();
    for (const op of ops) {
      if (op.id.seq <= this.seqOf(op.id.replica)) continue;
      this.early.set(idKey(op.id), op);
      touched.add(op.id.replica);
    }
    const accepted: Op[] = [];
    for (const replica of touched) {
      let log = this.byReplica.get(replica);
      for (;;) {
        const key = idKey({ replica, seq: this.seqOf(replica) + 1 });
        const next = this.early.get(key);
        if (!next) break;
        if (!log) this.byReplica.set(replica, (log = []));
        log.push(next);
        this.early.delete(key);
        accepted.push(next);
      }
    }
    return accepted;
  }

  versionVector(): VersionVector {
    const vv: VersionVector = {};
    for (const [r, log] of this.byReplica) vv[r] = log.length;
    return vv;
  }

  /** Ops a peer with version vector `remote` is missing. */
  since(remote: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [r, log] of this.byReplica) out.push(...log.slice(vvGet(remote, r)));
    return out;
  }

  get size(): number {
    let n = 0;
    for (const log of this.byReplica.values()) n += log.length;
    return n;
  }

  /** Ops held back because an earlier seq from the same replica is missing. */
  get waiting(): number {
    return this.early.size;
  }

  private seqOf(replica: ReplicaId): number {
    return this.byReplica.get(replica)?.length ?? 0;
  }
}
