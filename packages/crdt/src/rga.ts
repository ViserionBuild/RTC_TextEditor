import { compareStamps, idKey, type OpId, type Stamp } from './ids';
import type { DeleteOp, InsertOp } from './ops';

export interface Elem {
  readonly id: OpId;
  readonly ts: Stamp;
  readonly origin: OpId | null;
  readonly char: string;
  deleted: boolean;
}

/**
 * Replicated Growable Array. Elements are kept in document order, tombstones included.
 *
 * Phase 1 uses a flat array with O(n) position lookups; Phase 6 replaces this with
 * run-length items and a counted index.
 */
export class Rga {
  private readonly elems: Elem[] = [];
  private readonly byId = new Map<string, Elem>();

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
    const elem: Elem = { id: op.id, ts: op.ts, origin: op.origin, char: op.char, deleted: false };
    this.elems.splice(pos, 0, elem);
    this.byId.set(idKey(op.id), elem);
  }

  /** Tombstone the target. Deleting twice is a no-op. */
  integrateDelete(op: DeleteOp): void {
    const elem = this.byId.get(idKey(op.target));
    if (!elem) throw new Error(`delete target ${idKey(op.target)} not integrated`);
    elem.deleted = true;
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
