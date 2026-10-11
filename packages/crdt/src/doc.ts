import { LamportClock } from './clock';
import { sha256Hex } from './hash';
import { idEquals, idKey, type OpId, type ReplicaId } from './ids';
import type { DeleteOp, InsertOp, Op } from './ops';
import { Rga, type Elem } from './rga';
import { vvDominates, vvGet, type VersionVector } from './vv';

/** Legacy snapshot: the full op log, replayed on load. */
export interface DocSnapshotV1 {
  readonly version: 1;
  readonly lamport: number;
  readonly log: Record<ReplicaId, Op[]>;
  readonly pending: Op[];
}

/**
 * Element as stored in a snapshot: [replica, seq, lamport, char, deletedBy?].
 * The stamp's replica is always the id's replica, so it is not repeated.
 */
export type ElemTuple = [ReplicaId, number, number, string, OpId?];

/**
 * State snapshot: the element sequence itself. Needed once tombstones are collected, because
 * a pruned op log can no longer be replayed.
 */
export interface DocState {
  readonly version: 2;
  readonly lamport: number;
  readonly vv: VersionVector;
  readonly elements: ElemTuple[];
  /** Ops kept for anti-entropy (everything not yet known to be stable). */
  readonly log: Op[];
  readonly pending: Op[];
}

export type DocSnapshot = DocSnapshotV1 | DocState;

/**
 * Permission to garbage-collect, computed by the relay (see StabilityTracker).
 * Tombstones whose insert and delete are within `vv` may be removed by a replica that has
 * integrated everything in `requires`.
 */
export interface Collect {
  readonly vv: VersionVector;
  readonly requires: VersionVector;
}

/** A visible-text change caused by a remote op, in the order the ops were applied. */
export type Delta =
  | { readonly type: 'insert'; readonly index: number; readonly text: string }
  | { readonly type: 'delete'; readonly index: number; readonly length: number };

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
  private vv: VersionVector = {};
  /** Retained ops per replica, in seq order; ops at or below `logFloor` have been pruned. */
  private readonly log = new Map<ReplicaId, Op[]>();
  private logFloor: VersionVector = {};
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

  /**
   * Apply ops from another replica. Returns the ops that were newly applied, in order.
   * `onDelta` receives the visible-text effect of each one (editors use it to patch their view);
   * deleting an already-deleted character produces no delta.
   */
  applyRemote(ops: Iterable<Op>, onDelta?: (delta: Delta) => void): Op[] {
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
          if (onDelta) this.integrateWithDelta(op, onDelta);
          else this.integrate(op);
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

  /**
   * Ops this replica has that a peer with version vector `remote` is missing. Ops that were
   * pruned after becoming stable are not included (every replica already has them).
   */
  opsSince(remote: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [replica, ops] of this.log) {
      const skip = Math.max(0, vvGet(remote, replica) - vvGet(this.logFloor, replica));
      out.push(...ops.slice(skip));
    }
    return out;
  }

  // ---------- garbage collection ----------

  /**
   * Remove tombstones the relay has declared collectable, and prune stable ops from the log.
   * Returns the number of elements removed. Does nothing if this replica has not integrated
   * everything in `requires` (e.g. it reloaded an older state): a later round will cover it.
   */
  collect({ vv, requires }: Collect): number {
    if (!vvDominates(this.vv, requires)) return 0;
    const within = (id: OpId) => id.seq <= vvGet(vv, id.replica);
    const removed = this.rga.purge(
      (e) => within(e.id) && e.deletedBy !== null && within(e.deletedBy),
      (e) => within(e.id),
    );
    for (const [replica, ops] of this.log) {
      const floor = vvGet(this.logFloor, replica);
      const upTo = Math.min(vvGet(vv, replica), vvGet(this.vv, replica));
      if (upTo > floor) {
        ops.splice(0, upTo - floor);
        this.logFloor[replica] = upTo;
      }
    }
    return removed;
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
    // `ops` counts retained (unpruned) ops.
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

  /**
   * SHA-256 of the visible elements and their ids. Equal on converged replicas even when they
   * have collected different tombstones.
   */
  liveHash(): string {
    const canonical = this.rga
      .elements()
      .filter((e) => !e.deleted)
      .map((e) => `${idKey(e.id)}|${e.char}`)
      .join('\n');
    return sha256Hex(canonical);
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

  // ---------- element access (rebasing) ----------

  has(id: OpId): boolean {
    return this.rga.has(id);
  }

  isVisible(id: OpId): boolean {
    const e = this.rga.get(id);
    return e !== undefined && !e.deleted;
  }

  /** Document order, tombstones included. */
  elements(): readonly Elem[] {
    return this.rga.elements();
  }

  /** Delete one element by id if it is visible. */
  deleteElement(id: OpId): DeleteOp[] {
    return this.isVisible(id) ? this.deleteRange(this.rga.visibleIndexOf(id), 1) : [];
  }

  // ---------- persistence ----------

  snapshot(): DocState {
    return {
      version: 2,
      lamport: this.clock.value,
      vv: { ...this.vv },
      elements: this.rga
        .elements()
        .map((e): ElemTuple =>
          e.deletedBy
            ? [e.id.replica, e.id.seq, e.ts.lamport, e.char, e.deletedBy]
            : [e.id.replica, e.id.seq, e.ts.lamport, e.char],
        ),
      log: [...this.log.values()].flat(),
      pending: [...this.pending],
    };
  }

  static load(replica: ReplicaId, snap: DocSnapshot): Doc {
    const doc = new Doc(replica);
    if (snap.version === 1) {
      doc.applyRemote([...Object.values(snap.log).flat(), ...snap.pending]);
    } else {
      doc.adoptState(snap);
    }
    doc.clock.observe(snap.lamport);
    return doc;
  }

  /**
   * Replace an empty document's contents with a state snapshot (a new client bootstrapping
   * from the relay). Returns the delta that brings an editor showing "" up to date.
   */
  adoptState(state: DocState): Delta | null {
    if (Object.keys(this.vv).length > 0 || this.pending.length > 0) {
      throw new Error('adoptState requires an empty document');
    }
    this.rga.load(
      state.elements.map(([replica, seq, lamport, char, deletedBy]) => ({
        id: { replica, seq },
        ts: { lamport, replica },
        char,
        deleted: deletedBy !== undefined,
        deletedBy: deletedBy ?? null,
      })),
    );
    this.vv = { ...state.vv };
    this.clock.observe(state.lamport);
    // Retained ops start right after the floor; everything below it was pruned.
    const byReplica = new Map<ReplicaId, Op[]>();
    for (const op of state.log) {
      let l = byReplica.get(op.id.replica);
      if (!l) byReplica.set(op.id.replica, (l = []));
      l.push(op);
    }
    for (const [replica, seqTop] of Object.entries(state.vv)) {
      const ops = byReplica.get(replica) ?? [];
      this.log.set(replica, ops);
      this.logFloor[replica] = seqTop - ops.length;
    }
    this.applyRemote(state.pending);
    const text = this.text();
    return text ? { type: 'insert', index: 0, text } : null;
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

  private integrateWithDelta(op: Op, onDelta: (delta: Delta) => void): void {
    if (op.type === 'ins') {
      this.integrate(op);
      onDelta({ type: 'insert', index: this.rga.visibleIndexOf(op.id), text: op.char });
      return;
    }
    const wasVisible = !this.rga.get(op.target)!.deleted;
    const index = wasVisible ? this.rga.visibleIndexOf(op.target) : -1;
    this.integrate(op);
    if (wasVisible) onDelta({ type: 'delete', index, length: 1 });
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
