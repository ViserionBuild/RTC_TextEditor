import type { Doc } from './doc';
import { idKey, type OpId } from './ids';
import type { Op } from './ops';
import { vvGet, type VersionVector } from './vv';

/**
 * Replay `from`'s unacknowledged local edits onto `onto` as fresh local ops.
 *
 * Used when a replica must rejoin under a new id (it was evicted, or arrived with offline edits
 * after GC started): its raw ops may reference elements others have purged, so they cannot be
 * sent as-is. Instead each edit is re-expressed relative to what `onto` (bootstrapped from the
 * relay) contains:
 *  - an unacked delete removes its target if `onto` still shows it;
 *  - an unacked insert that is still visible locally is re-inserted after the nearest element
 *    to its left that `onto` knows (or that was itself re-inserted).
 *
 * `acked` is the relay's vector as last confirmed to `from`.
 */
export function rebaseUnacked(from: Doc, acked: VersionVector, onto: Doc): Op[] {
  const self = from.replica;
  const unacked = from.opsSince(acked).filter((op) => op.id.replica === self);
  /** Elements created by our own unacked inserts never reached the relay. */
  const isUnackedOwn = (id: OpId) => id.replica === self && id.seq > vvGet(acked, self);
  const out: Op[] = [];

  for (const op of unacked) {
    if (op.type === 'del' && !isUnackedOwn(op.target)) out.push(...onto.deleteElement(op.target));
  }

  const order = from.elements();
  const position = new Map(order.map((e, i) => [idKey(e.id), i]));
  const mapped = new Map<string, OpId>();
  const locate = (id: OpId): OpId | null =>
    mapped.get(idKey(id)) ?? (!isUnackedOwn(id) && onto.has(id) ? id : null);

  for (const op of unacked) {
    if (op.type !== 'ins' || !from.isVisible(op.id)) continue;
    let anchor: OpId | null = null;
    for (let i = position.get(idKey(op.id))! - 1; i >= 0 && anchor === null; i--) {
      anchor = locate(order[i]!.id);
    }
    const index = onto.resolveAnchor(anchor);
    const [ins] = onto.insertAt(index, op.char);
    mapped.set(idKey(op.id), ins!.id);
    out.push(ins!);
  }
  return out;
}
