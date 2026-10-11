import { LamportClock } from './clock';
import { sha256Hex } from './hash';
import { idEquals, idKey, type OpId, type ReplicaId } from './ids';
import type { DeleteOp, InsertOp, Op } from './ops';
import { Rga } from './rga';
import { vvGet, type VersionVector } from './vv';

export interface DocSnapshot {
  readonly version: 1;
  readonly lamport: number;
  /** Every applied op, grouped by replica in seq order. */
  readonly log: Record<ReplicaId, Op[]>;
  /** Received ops still waiting on a causal dependency. */
  readonly pending: Op[];
}

/** A cursor position that survives concurrent edits: "just after element X" (null = start). */
export type Anchor = OpId | null;

/**
 * One replica of a collaborative plain-text document.
 *
 * Remote ops may arrive in any order, any number of times. An op is applied only when it is
 * causally ready: it is the next seq from its replica and the element it references exists.
 * Duplicates are dropped by comparing against the version vector, so delivery is idempotent.
 */
export class Doc {
  readonly replica: ReplicaId;
  private readonly rga = new Rga();
  private readonly clock = new LamportClock();
  private readonly vv: VersionVector = {};
  private readonly log = new Map<ReplicaId, Op[]>();
  private pending: Op[] = [];

  constructor(replica: ReplicaId) {
    if (!replica) throw new Error('replica id must be non-empty');
    this.replica = replica;
  }

  // ---------- local edits ----------

  /** Insert `text` at a visible index. Returns the ops to broadcast. */
  insertAt(index: number, text: string): InsertOp[] {
    this.checkIndex(index, 0);
    let origin: OpId | null = index === 0 ? null : this.rga.visibleAt(index - 1)!.id;
    const ops: InsertOp[] = [];
    for (const char of splitUnits(text)) {
      const op: InsertOp = { type: 'ins', id: this.nextId(), ts: this.nextStamp(), origin, char };
      this.integrate(op);
      ops.push(op);
      origin = op.id;
    }
    return ops;
  }

  /** Delete `length` visible characters starting at `index`. Returns the ops to broadcast. */
  deleteRange(index: number, length: number): DeleteOp[] {
    this.checkIndex(index, length);
    const targets: OpId[] = [];
    for (let i = 0; i < length; i++) targets.push(this.rga.visibleAt(index + i)!.id);
    return targets.map((target) => {
      const op: DeleteOp = { type: 'del', id: this.nextId(), ts: this.nextStamp(), target };
      this.integrate(op);
      return op;
    });
  }

  // ---------- remote ops ----------

  /** Apply ops from another replica. Returns the ops that were newly applied, in order. */
  applyRemote(ops: Iterable<Op>): Op[] {
    const applied: Op[] = [];
    for (const op of ops) {
      if (this.isDuplicate(op) || this.pending.some((p) => idEquals(p.id, op.id))) continue;
      this.pending.push(op);
    }
    // Drain the buffer until no op makes progress: applying one op can unblock others.
    let progressed = true;
    while (progressed) {
      progressed = false;
      const still: Op[] = [];
      for (const op of this.pending) {
        if (this.isDuplicate(op)) continue;
        if (this.isReady(op)) {
          this.clock.observe(op.ts.lamport);
          this.integrate(op);
          applied.push(op);
          progressed = true;
        } else {
          still.push(op);
        }
      }
      this.pending = still;
    }
    return applied;
  }

  // ---------- anti-entropy ----------

  versionVector(): VersionVector {
    return { ...this.vv };
  }

  /** Ops this replica has that a peer with version vector `remote` is missing. */
  opsSince(remote: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [replica, ops] of this.log) out.push(...ops.slice(vvGet(remote, replica)));
    return out;
  }

  // ---------- reading ----------

  text(): string {
    return this.rga.text();
  }

  get length(): number {
    return this.rga.visibleLength;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  stats(): { visible: number; tombstones: number; elements: number; ops: number } {
    let ops = 0;
    for (const l of this.log.values()) ops += l.length;
    return {
      visible: this.rga.visibleLength,
      tombstones: this.rga.tombstoneCount,
      elements: this.rga.size,
      ops,
    };
  }

  /** SHA-256 of the visible text. Equal on all replicas once they have the same ops. */
  stateHash(): string {
    return sha256Hex(this.text());
  }

  /** SHA-256 of the full element sequence, tombstones and ids included. */
  fullHash(): string {
    const canonical = this.rga
      .elements()
      .map((e) => `${idKey(e.id)}|${e.deleted ? 1 : 0}|${e.char}`)
      .join('\n');
    return sha256Hex(canonical);
  }

  // ---------- cursors ----------

  /** Anchor a cursor at a visible index to the element on its left. */
  anchorAt(index: number): Anchor {
    this.checkIndex(index, 0);
    return index === 0 ? null : this.rga.visibleAt(index - 1)!.id;
  }

  /** Current visible index of an anchored cursor. A deleted anchor collapses to its slot. */
  resolveAnchor(anchor: Anchor): number {
    if (anchor === null) return 0;
    const elem = this.rga.get(anchor);
    if (!elem) return 0;
    return this.rga.visibleIndexOf(anchor) + (elem.deleted ? 0 : 1);
  }

  // ---------- persistence ----------

  snapshot(): DocSnapshot {
    const log: Record<ReplicaId, Op[]> = {};
    for (const [r, ops] of this.log) log[r] = [...ops];
    return { version: 1, lamport: this.clock.value, log, pending: [...this.pending] };
  }

  static load(replica: ReplicaId, snap: DocSnapshot): Doc {
    const doc = new Doc(replica);
    doc.applyRemote([...Object.values(snap.log).flat(), ...snap.pending]);
    doc.clock.observe(snap.lamport);
    return doc;
  }

  // ---------- internals ----------

  private isDuplicate(op: Op): boolean {
    return op.id.seq <= vvGet(this.vv, op.id.replica);
  }

  private isReady(op: Op): boolean {
    if (op.id.seq !== vvGet(this.vv, op.id.replica) + 1) return false;
    if (op.type === 'ins') return op.origin === null || this.rga.has(op.origin);
    return this.rga.has(op.target);
  }

  private integrate(op: Op): void {
    if (op.type === 'ins') this.rga.integrateInsert(op);
    else this.rga.integrateDelete(op);
    this.vv[op.id.replica] = op.id.seq;
    let l = this.log.get(op.id.replica);
    if (!l) this.log.set(op.id.replica, (l = []));
    l.push(op);
  }

  private nextId(): OpId {
    return { replica: this.replica, seq: vvGet(this.vv, this.replica) + 1 };
  }

  private nextStamp() {
    return { lamport: this.clock.tick(), replica: this.replica };
  }

  private checkIndex(index: number, length: number): void {
    if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 0) {
      throw new RangeError(`invalid range ${index}+${length}`);
    }
    if (index + length > this.rga.visibleLength) {
      throw new RangeError(`range ${index}+${length} exceeds length ${this.rga.visibleLength}`);
    }
  }
}

/** Split into UTF-16 code units, matching editor (CodeMirror / DOM) offsets. */
function splitUnits(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) out.push(text[i]!);
  return out;
}
