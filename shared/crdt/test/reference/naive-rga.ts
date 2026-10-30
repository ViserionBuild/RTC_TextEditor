import { compareStamps, idKey, type OpId, type Stamp } from '../../src/ids';
import type { DeleteOp, InsertOp } from '../../src/ops';

export interface Elem {
  readonly id: OpId;
  readonly ts: Stamp;
  readonly char: string;
  deleted: boolean;
  /** The first delete op that tombstoned this element (drives garbage collection). */
  deletedBy: OpId | null;
}

/**
 * Replicated Growable Array. Elements are kept in document order, tombstones included.
 *
 * Phase 1 uses a flat array with O(n) position lookups; Phase 6 replaces this with
 * run-length items and a counted index.
 */
/** The original O(n) RGA, kept as an oracle for the run-length implementation. */
export class NaiveRga {
  private elems: Elem[] = [];
  private readonly byId = new Map<string, Elem>();

  /** Replace the whole sequence (loading a snapshot). */
  load(elems: Elem[]): void {
    this.elems = elems;
    this.byId.clear();
    for (const e of elems) this.byId.set(idKey(e.id), e);
  }

  has(id: OpId): boolean {
    return this.byId.has(idKey(id));
  }

  get(id: OpId): Elem | undefined {
    return this.byId.get(idKey(id));
  }

  /**
   * Place a new element after its origin, skipping every element with a larger stamp.
   * Lamport stamps make descendants larger than their ancestors, so this skips whole
   * subtrees of concurrent siblings that sort before us, and stops at the first element
   * that sorts after us. The caller guarantees the origin is already integrated.
   */
  integrateInsert(op: InsertOp): void {
    let pos = op.origin === null ? 0 : this.positionOf(op.origin) + 1;
    while (pos < this.elems.length && compareStamps(this.elems[pos]!.ts, op.ts) > 0) pos++;
    // The origin is only needed to find the position; it is not stored.
    const elem: Elem = { id: op.id, ts: op.ts, char: op.char, deleted: false, deletedBy: null };
    this.elems.splice(pos, 0, elem);
    this.byId.set(idKey(op.id), elem);
  }

  /** Tombstone the target. Deleting twice is a no-op. */
  integrateDelete(op: DeleteOp): void {
    const elem = this.byId.get(idKey(op.target));
    if (!elem) throw new Error(`delete target ${idKey(op.target)} not integrated`);
    if (elem.deleted) return;
    elem.deleted = true;
    elem.deletedBy = op.id;
  }

  /**
   * Remove tombstones for which `collectable` holds, but only in runs whose right neighbour
   * (the first surviving element after the run) satisfies `isOld`, or that end the document.
   *
   * Why the neighbour matters: an incoming insert scans right from its origin and stops at the
   * first element with a smaller stamp. Old tombstones are such stopping points. If the
   * element after a purged run were newer than an incoming insert, the scan would skip past
   * where the run used to be, and land somewhere a replica that still has the run would not.
   * With an old neighbour, the scan stops in the same place either way.
   */
  purge(collectable: (e: Elem) => boolean, isOld: (e: Elem) => boolean): number {
    let neighbourOld = true; // end of document
    const keep: Elem[] = [];
    for (let i = this.elems.length - 1; i >= 0; i--) {
      const e = this.elems[i]!;
      if (neighbourOld && e.deleted && collectable(e)) {
        this.byId.delete(idKey(e.id));
        continue;
      }
      keep.push(e);
      neighbourOld = isOld(e);
    }
    const removed = this.elems.length - keep.length;
    this.elems = keep.reverse();
    return removed;
  }

  /** Visible element at a visible index. */
  visibleAt(index: number): Elem | undefined {
    let i = 0;
    for (const e of this.elems) {
      if (e.deleted) continue;
      if (i === index) return e;
      i++;
    }
    return undefined;
  }

  /** Number of visible elements strictly before `id` (works for tombstones too). */
  visibleIndexOf(id: OpId): number {
    const target = this.get(id);
    if (!target) throw new Error(`unknown element ${idKey(id)}`);
    let i = 0;
    for (const e of this.elems) {
      if (e === target) return i;
      if (!e.deleted) i++;
    }
    /* c8 ignore next */
    throw new Error('index out of sync');
  }

  get visibleLength(): number {
    let n = 0;
    for (const e of this.elems) if (!e.deleted) n++;
    return n;
  }

  get tombstoneCount(): number {
    return this.elems.length - this.visibleLength;
  }

  get size(): number {
    return this.elems.length;
  }

  text(): string {
    let s = '';
    for (const e of this.elems) if (!e.deleted) s += e.char;
    return s;
  }

  elements(): readonly Elem[] {
    return this.elems;
  }

  private positionOf(id: OpId): number {
    const target = this.get(id);
    if (!target) throw new Error(`origin ${idKey(id)} not integrated`);
    return this.elems.indexOf(target);
  }
}
