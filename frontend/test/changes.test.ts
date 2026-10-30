import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { Doc, type Delta, type Op } from '@collabpad/crdt';
import { describe, expect, it } from 'vitest';
import { coalesce, deltasToChangeSet, localChangesToOps } from '../src/collab/changes';

/** A headless editor wired to a CRDT replica exactly like the collab plugin does it. */
class Replica {
  readonly doc: Doc;
  state: EditorState;
  constructor(id: string) {
    this.doc = new Doc(id);
    this.state = EditorState.create({
      doc: '',
      extensions: EditorState.allowMultipleSelections.of(true),
    });
  }
  edit(spec: TransactionSpec) {
    const tr = this.state.update(spec);
    this.state = tr.state;
    return localChangesToOps(this.doc, tr.changes);
  }
  receive(ops: Op[]) {
    const deltas: Delta[] = [];
    this.doc.applyRemote(ops, (d) => deltas.push(d));
    this.state = this.state.update({
      changes: deltasToChangeSet(deltas, this.state.doc.length),
    }).state;
  }
  get inSync() {
    return this.state.doc.toString() === this.doc.text();
  }
}

describe('CodeMirror ↔ CRDT changes', () => {
  it('translates multi-range transactions (multi-cursor typing, replace selection)', () => {
    const r = new Replica('a');
    r.edit({ changes: { from: 0, insert: 'one two three' } });
    r.edit({
      changes: [
        { from: 0, to: 3, insert: 'ONE' },
        { from: 4, insert: '[' },
        { from: 7, insert: ']' },
        { from: 8, to: 13 },
      ],
    });
    expect(r.state.doc.toString()).toBe('ONE [two] ');
    expect(r.inSync).toBe(true);

    r.edit(
      r.state.changeByRange((range) => ({ changes: { from: range.from, insert: '\n' }, range })),
    );
    expect(r.inSync).toBe(true);
  });

  it('keeps two editors identical through concurrent random edits', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const [a, b] = [new Replica('a'), new Replica('b')];
    const outA: Op[] = [];
    const outB: Op[] = [];
    for (let i = 0; i < 400; i++) {
      for (const [r, out] of [
        [a, outA],
        [b, outB],
      ] as const) {
        const len = r.state.doc.length;
        const from = Math.floor(rand() * (len + 1));
        const to = Math.min(len, from + (rand() < 0.3 ? Math.floor(rand() * 4) : 0));
        const insert = rand() < 0.7 ? ['x', 'yz', '\n', 'héllo'][Math.floor(rand() * 4)]! : '';
        out.push(
          ...r.edit({ changes: { from, to, insert }, selection: EditorSelection.cursor(from) }),
        );
      }
      if (rand() < 0.25) {
        b.receive(outA.splice(0));
        a.receive(outB.splice(0));
      }
      expect(a.inSync && b.inSync).toBe(true);
    }
    b.receive(outA.splice(0));
    a.receive(outB.splice(0));
    expect(a.state.doc.toString()).toBe(b.state.doc.toString());
  });

  it('coalesces typing runs, forward deletes and backspaces', () => {
    expect(
      coalesce([
        { type: 'insert', index: 0, text: 'a' },
        { type: 'insert', index: 1, text: 'b' },
        { type: 'delete', index: 5, length: 1 },
        { type: 'delete', index: 5, length: 1 },
        { type: 'delete', index: 4, length: 1 },
        { type: 'insert', index: 9, text: 'z' },
      ]),
    ).toEqual([
      { type: 'insert', index: 0, text: 'ab' },
      { type: 'delete', index: 4, length: 3 },
      { type: 'insert', index: 9, text: 'z' },
    ]);
  });
});
