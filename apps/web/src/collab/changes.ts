import { ChangeSet } from '@codemirror/state';
import type { Delta, Doc, Op } from '@collabpad/crdt';

/**
 * Apply a local CodeMirror change set to the CRDT and return the ops to broadcast.
 *
 * iterChanges walks changes in ascending order. `fromA/toA` are positions in the old document,
 * `fromB` is the position in the new one. Once earlier changes are applied, the CRDT text
 * matches the new document up to `fromB` and the old one after it, so each change is
 * "delete the old range at fromB, then insert at fromB".
 */
export function localChangesToOps(doc: Doc, changes: ChangeSet): Op[] {
  let ops: Op[] = [];
  changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    // concat, not push(...): a huge paste or delete would overflow the call stack.
    if (toA > fromA) ops = ops.concat(doc.deleteRange(fromB, toA - fromA));
    if (inserted.length) ops = ops.concat(doc.insertAt(fromB, inserted.toString()));
  });
  return ops;
}

/** Merge per-character deltas into runs: typed words, forward deletes and backspaces. */
export function coalesce(deltas: readonly Delta[]): Delta[] {
  const out: Delta[] = [];
  for (const d of deltas) {
    const prev = out.at(-1);
    if (
      prev?.type === 'insert' &&
      d.type === 'insert' &&
      d.index === prev.index + prev.text.length
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + d.text };
    } else if (prev?.type === 'delete' && d.type === 'delete' && d.index === prev.index) {
      out[out.length - 1] = { ...prev, length: prev.length + d.length };
    } else if (
      prev?.type === 'delete' &&
      d.type === 'delete' &&
      d.index + d.length === prev.index
    ) {
      out[out.length - 1] = { type: 'delete', index: d.index, length: prev.length + d.length };
    } else {
      out.push(d);
    }
  }
  return out;
}

/** Turn sequential remote deltas into a single change set over a document of `length`. */
export function deltasToChangeSet(deltas: readonly Delta[], length: number): ChangeSet {
  let set = ChangeSet.empty(length);
  for (const d of coalesce(deltas)) {
    const step =
      d.type === 'insert'
        ? ChangeSet.of({ from: d.index, insert: d.text }, set.newLength)
        : ChangeSet.of({ from: d.index, to: d.index + d.length }, set.newLength);
    set = set.compose(step);
  }
  return set;
}
