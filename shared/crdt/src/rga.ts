import { compareStamps, type OpId, type ReplicaId, type Stamp } from './ids';
import type { DeleteOp, InsertOp } from './ops';
import { vvGet, vvMerge, type VersionVector } from './vv';

/** One character, materialized (snapshots, hashing, rebasing). */
export interface Elem {
  readonly id: OpId;
  readonly ts: Stamp;
  readonly char: string;
  readonly deleted: boolean;
}

/**
 * A run of characters inserted by one replica with consecutive seqs and Lamport stamps, each
 * placed right after the previous one: the shape of normal typing. Character i has id
 * (replica, seq + i) and stamp (lamport + i, replica). A run is all visible or all deleted.
 */
interface Item {
  readonly replica: ReplicaId;
  readonly seq: number;
  readonly lamport: number;
  text: string;
  deleted: boolean;
  /**
   * For tombstones: the highest delete seq per replica over the run's characters. Garbage
   * collection only needs "every delete is stable", so merging runs keeps this conservative.
   */
  delBy: VersionVector | null;
  chunk: Chunk;
}

/** A block of consecutive items with cached counts, so positions resolve in ~O(√n). */
interface Chunk {
  items: Item[];
  visible: number;
  size: number;
}

/** Serialized run: [replica, seq, lamport, text, delBy (tombstones only)]. */
export type ItemTuple = [ReplicaId, number, number, string, VersionVector?];

const CHUNK_MAX = 128;

const lastSeq = (it: Item) => it.seq + it.text.length - 1;
const newChunk = (): Chunk => ({ items: [], visible: 0, size: 0 });

/**
 * Replicated Growable Array with run-length items and a chunked index.
 *
 * Semantics are identical to the per-character RGA (kept in test/reference as an oracle):
 * an insert goes right after its origin, skipping every element with a larger stamp. Because
 * stamps increase along a run, a whole run can be skipped or stopped at by looking at its
 * first character.
 */
export class Rga {
  private chunks: Chunk[] = [newChunk()];
  /** Each replica's items sorted by seq, for id lookups by binary search. */
  private readonly byReplica = new Map<ReplicaId, Item[]>();

  // ---------- queries ----------

  has(id: OpId): boolean {
    return this.find(id) !== undefined;
  }

  isDeleted(id: OpId): boolean {
    return this.find(id)?.deleted ?? false;
  }

  get visibleLength(): number {
    let n = 0;
    for (const c of this.chunks) n += c.visible;
    return n;
  }

  /** Characters including tombstones. */
  get size(): number {
    let n = 0;
    for (const c of this.chunks) n += c.size;
    return n;
  }

  get tombstoneCount(): number {
    return this.size - this.visibleLength;
  }

  /** Number of runs (the real unit of metadata). */
  get itemCount(): number {
    let n = 0;
    for (const c of this.chunks) n += c.items.length;
    return n;
  }

  /** Id of the visible character at a visible index. */
  idAtVisible(index: number): OpId {
    for (const c of this.chunks) {
      if (index >= c.visible) {
        index -= c.visible;
        continue;
      }
      for (const it of c.items) {
        if (it.deleted) continue;
        if (index < it.text.length) return { replica: it.replica, seq: it.seq + index };
        index -= it.text.length;
      }
    }
    throw new RangeError('visible index out of range');
  }

  /** Number of visible characters strictly before `id` (works for tombstones too). */
  visibleIndexOf(id: OpId): number {
    const it = this.find(id);
    if (!it) throw new Error(`unknown element ${id.seq}@${id.replica}`);
    return this.visibleBefore(it) + (it.deleted ? 0 : id.seq - it.seq);
  }

  text(): string {
    let s = '';
    for (const c of this.chunks) for (const it of c.items) if (!it.deleted) s += it.text;
    return s;
  }

  /** Every character in document order, tombstones included. */
  elements(): Elem[] {
    const out: Elem[] = [];
    for (const c of this.chunks) {
      for (const it of c.items) {
        for (let i = 0; i < it.text.length; i++) {
          out.push({
            id: { replica: it.replica, seq: it.seq + i },
            ts: { lamport: it.lamport + i, replica: it.replica },
            char: it.text[i]!,
            deleted: it.deleted,
          });
        }
      }
    }
    return out;
  }

  // ---------- integration ----------

  integrateInsert(op: InsertOp): void {
    let ci = 0;
    let ii = 0;
    if (op.origin !== null) {
      const o = this.find(op.origin);
      if (!o) throw new Error(`origin ${op.origin.seq}@${op.origin.replica} not integrated`);
      const off = op.origin.seq - o.seq;
      [ci, ii] = this.locate(o);
      if (off < o.text.length - 1) {
        // The origin is inside a run: the rest of the run is skipped as a whole or stops us.
        const next: Stamp = { lamport: o.lamport + off + 1, replica: o.replica };
        if (compareStamps(next, op.ts) < 0) {
          const right = this.split(o, off + 1);
          this.insertNew(op, right.chunk, right.chunk.items.indexOf(right));
          return;
        }
      }
      ii++;
    }
    // Skip every run whose first (smallest) stamp is larger than ours.
    for (;;) {
      if (ii >= this.chunks[ci]!.items.length) {
        if (ci + 1 >= this.chunks.length) break;
        ci++;
        ii = 0;
        continue;
      }
      const it = this.chunks[ci]!.items[ii]!;
      if (compareStamps({ lamport: it.lamport, replica: it.replica }, op.ts) <= 0) break;
      ii++;
    }
    this.insertNew(op, this.chunks[ci]!, ii);
  }

  /** Tombstone the target (isolating it from its run). Deleting twice only records the deleter. */
  integrateDelete(op: DeleteOp): void {
    let it = this.find(op.target);
    if (!it) throw new Error(`delete target ${op.target.seq}@${op.target.replica} not integrated`);
    const mark: VersionVector = { [op.id.replica]: op.id.seq };
    if (it.deleted) {
      it.delBy = vvMerge(it.delBy ?? {}, mark);
      return;
    }
    const off = op.target.seq - it.seq;
    if (off > 0) it = this.split(it, off);
    if (it.text.length > 1) this.split(it, 1);
    it.deleted = true;
    it.delBy = mark;
    it.chunk.visible -= 1;
    this.mergeTombstones(it);
  }

  // ---------- garbage collection ----------

  /**
   * Remove tombstone runs inserted and deleted within `stable`, but only where the first
   * surviving element to the right was also inserted within `stable` (or there is none).
   * An incoming insert stops its scan at old elements; with an old neighbour it stops in the
   * same place whether or not the run is still there. See docs/TOMBSTONES.md.
   */
  collect(stable: VersionVector): number {
    const within = (r: ReplicaId, seq: number) => seq <= vvGet(stable, r);
    let neighbourOld = true; // end of document
    let removed = 0;
    for (let ci = this.chunks.length - 1; ci >= 0; ci--) {
      const c = this.chunks[ci]!;
      for (let ii = c.items.length - 1; ii >= 0; ii--) {
        const it = c.items[ii]!;
        const collectable =
          it.deleted &&
          within(it.replica, lastSeq(it)) &&
          Object.entries(it.delBy ?? {}).every(([r, s]) => within(r, s));
        if (neighbourOld && collectable) {
          c.items.splice(ii, 1);
          c.size -= it.text.length;
          this.unindex(it);
          removed += it.text.length;
        } else {
          neighbourOld = within(it.replica, it.seq);
        }
      }
    }
    this.chunks = this.chunks.filter((c) => c.items.length > 0);
    if (this.chunks.length === 0) this.chunks.push(newChunk());
    return removed;
  }

  // ---------- persistence ----------

  exportItems(): ItemTuple[] {
    const out: ItemTuple[] = [];
    for (const c of this.chunks) {
      for (const it of c.items) {
        out.push(
          it.deleted
            ? [it.replica, it.seq, it.lamport, it.text, { ...it.delBy }]
            : [it.replica, it.seq, it.lamport, it.text],
        );
      }
    }
    return out;
  }

  /** Replace the sequence with serialized runs, in document order. */
  load(items: readonly ItemTuple[]): void {
    this.chunks = [];
    this.byReplica.clear();
    let chunk = newChunk();
    for (const [replica, seq, lamport, text, delBy] of items) {
      if (chunk.items.length >= CHUNK_MAX) {
        this.chunks.push(chunk);
        chunk = newChunk();
      }
      const it: Item = {
        replica,
        seq,
        lamport,
        text,
        deleted: delBy !== undefined,
        delBy: delBy ?? null,
        chunk,
      };
      chunk.items.push(it);
      chunk.size += text.length;
      if (!it.deleted) chunk.visible += text.length;
      let list = this.byReplica.get(replica);
      if (!list) this.byReplica.set(replica, (list = []));
      list.push(it);
    }
    this.chunks.push(chunk);
    for (const list of this.byReplica.values()) list.sort((a, b) => a.seq - b.seq);
  }

  // ---------- internals ----------

  private find(id: OpId): Item | undefined {
    const list = this.byReplica.get(id.replica);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const it = list[mid]!;
      if (id.seq < it.seq) hi = mid - 1;
      else if (id.seq > lastSeq(it)) lo = mid + 1;
      else return it;
    }
    return undefined;
  }

  private locate(it: Item): [number, number] {
    return [this.chunks.indexOf(it.chunk), it.chunk.items.indexOf(it)];
  }

  private visibleBefore(target: Item): number {
    let n = 0;
    for (const c of this.chunks) {
      if (c === target.chunk) break;
      n += c.visible;
    }
    for (const it of target.chunk.items) {
      if (it === target) break;
      if (!it.deleted) n += it.text.length;
    }
    return n;
  }

  /** Put a new character at (chunk, index), extending the preceding run when it continues it. */
  private insertNew(op: InsertOp, chunk: Chunk, index: number): void {
    const prev = index > 0 ? chunk.items[index - 1] : this.lastOfPreviousChunk(chunk);
    if (
      prev &&
      !prev.deleted &&
      prev.replica === op.id.replica &&
      lastSeq(prev) + 1 === op.id.seq &&
      prev.lamport + prev.text.length === op.ts.lamport &&
      op.origin?.replica === prev.replica &&
      op.origin.seq === lastSeq(prev)
    ) {
      prev.text += op.char;
      prev.chunk.visible++;
      prev.chunk.size++;
      return;
    }
    const it: Item = {
      replica: op.id.replica,
      seq: op.id.seq,
      lamport: op.ts.lamport,
      text: op.char,
      deleted: false,
      delBy: null,
      chunk,
    };
    chunk.items.splice(index, 0, it);
    chunk.visible++;
    chunk.size++;
    this.index(it);
    this.balance(chunk);
  }

  private lastOfPreviousChunk(chunk: Chunk): Item | undefined {
    const ci = this.chunks.indexOf(chunk);
    return ci > 0 ? this.chunks[ci - 1]!.items.at(-1) : undefined;
  }

  /** Split a run so that `it` keeps its first `offset` characters; returns the right part. */
  private split(it: Item, offset: number): Item {
    const right: Item = {
      replica: it.replica,
      seq: it.seq + offset,
      lamport: it.lamport + offset,
      text: it.text.slice(offset),
      deleted: it.deleted,
      delBy: it.delBy && { ...it.delBy },
      chunk: it.chunk,
    };
    it.text = it.text.slice(0, offset);
    const items = it.chunk.items;
    items.splice(items.indexOf(it) + 1, 0, right);
    const list = this.byReplica.get(it.replica)!;
    list.splice(list.indexOf(it) + 1, 0, right);
    this.balance(it.chunk);
    return right;
  }

  /** Re-join a freshly deleted run with adjacent tombstones it continues (keeps runs long). */
  private mergeTombstones(it: Item): void {
    const items = it.chunk.items;
    const i = items.indexOf(it);
    const continues = (a: Item, b: Item) =>
      a.deleted &&
      b.deleted &&
      a.replica === b.replica &&
      lastSeq(a) + 1 === b.seq &&
      a.lamport + a.text.length === b.lamport;
    const absorb = (left: Item, right: Item) => {
      left.text += right.text;
      left.delBy = vvMerge(left.delBy ?? {}, right.delBy ?? {});
      items.splice(items.indexOf(right), 1);
      this.unindex(right);
    };
    const next = items[i + 1];
    if (next && continues(it, next)) absorb(it, next);
    const prev = items[i - 1];
    if (prev && continues(prev, it)) absorb(prev, it);
  }

  private index(it: Item): void {
    let list = this.byReplica.get(it.replica);
    if (!list) this.byReplica.set(it.replica, (list = []));
    // New runs carry the replica's newest seq (ops arrive in seq order per replica).
    if (list.length === 0 || list.at(-1)!.seq < it.seq) {
      list.push(it);
      return;
    }
    let lo = 0;
    while (lo < list.length && list[lo]!.seq < it.seq) lo++;
    list.splice(lo, 0, it);
  }

  private unindex(it: Item): void {
    const list = this.byReplica.get(it.replica)!;
    list.splice(list.indexOf(it), 1);
  }

  /** Split an oversized chunk in two. */
  private balance(chunk: Chunk): void {
    if (chunk.items.length <= 2 * CHUNK_MAX) return;
    const right = newChunk();
    right.items = chunk.items.splice(CHUNK_MAX);
    for (const it of right.items) {
      it.chunk = right;
      right.size += it.text.length;
      if (!it.deleted) right.visible += it.text.length;
    }
    chunk.size -= right.size;
    chunk.visible -= right.visible;
    this.chunks.splice(this.chunks.indexOf(chunk) + 1, 0, right);
  }
}
