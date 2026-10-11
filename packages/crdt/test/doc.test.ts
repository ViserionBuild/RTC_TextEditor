import { describe, expect, it } from 'vitest';
import { Doc } from '../src';

describe('Doc local editing', () => {
  it('inserts and deletes like a string', () => {
    const d = new Doc('a');
    d.insertAt(0, 'hello');
    d.insertAt(5, ' world');
    d.insertAt(0, '>');
    expect(d.text()).toBe('>hello world');
    d.deleteRange(0, 1);
    d.deleteRange(5, 6);
    expect(d.text()).toBe('hello');
    expect(d.length).toBe(5);
    expect(d.stats()).toEqual({ visible: 5, tombstones: 7, elements: 12, ops: 19 });
  });

  it('inserts after tombstones at the right visible index', () => {
    const d = new Doc('a');
    d.insertAt(0, 'abc');
    d.deleteRange(1, 1);
    d.insertAt(1, 'X');
    expect(d.text()).toBe('aXc');
  });

  it('assigns contiguous seqs and chains multi-char inserts', () => {
    const d = new Doc('a');
    const ops = d.insertAt(0, 'hi');
    expect(ops.map((o) => o.id.seq)).toEqual([1, 2]);
    expect(ops[1]!.origin).toEqual(ops[0]!.id);
    expect(d.deleteRange(0, 1)[0]!.id.seq).toBe(3);
    expect(d.versionVector()).toEqual({ a: 3 });
  });

  it('rejects out-of-range edits', () => {
    const d = new Doc('a');
    d.insertAt(0, 'ab');
    expect(() => d.insertAt(3, 'x')).toThrow(RangeError);
    expect(() => d.insertAt(-1, 'x')).toThrow(RangeError);
    expect(() => d.deleteRange(1, 2)).toThrow(RangeError);
    expect(() => d.deleteRange(0.5, 1)).toThrow(RangeError);
    expect(() => new Doc('')).toThrow();
  });
});

describe('anchors', () => {
  it('keep a cursor attached to its character while others edit before it', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    b.applyRemote(a.insertAt(0, 'hello'));
    const cursor = b.anchorAt(3); // between "hel" and "lo"
    a.applyRemote(b.insertAt(0, '>>> '));
    expect(b.resolveAnchor(cursor)).toBe(7);
    expect(b.resolveAnchor(null)).toBe(0);
    expect(b.anchorAt(0)).toBeNull();
  });

  it('collapse to the deleted slot when their character is removed', () => {
    const d = new Doc('a');
    d.insertAt(0, 'abcd');
    const cursor = d.anchorAt(2); // after "b"
    d.deleteRange(1, 2); // remove "bc"
    expect(d.text()).toBe('ad');
    expect(d.resolveAnchor(cursor)).toBe(1);
    expect(d.resolveAnchor({ replica: 'zzz', seq: 9 })).toBe(0);
  });
});

describe('snapshot / load', () => {
  it('round-trips state and keeps generating fresh ids', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    a.insertAt(0, 'abc');
    b.applyRemote(a.opsSince({}));
    b.insertAt(3, 'Z');
    a.applyRemote(b.opsSince(a.versionVector()));
    a.deleteRange(0, 1);

    const restored = Doc.load('a', JSON.parse(JSON.stringify(a.snapshot())));
    expect(restored.text()).toBe('bcZ');
    expect(restored.fullHash()).toBe(a.fullHash());
    expect(restored.versionVector()).toEqual(a.versionVector());
    const [op] = restored.insertAt(0, 'q');
    expect(op!.id.seq).toBe(5);
    expect(op!.ts.lamport).toBeGreaterThan(a.snapshot().lamport);
  });

  it('keeps ops that were still pending', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    const ops = a.insertAt(0, 'xy');
    b.applyRemote([ops[1]!]);
    expect(b.pendingCount).toBe(1);
    const restored = Doc.load('b', b.snapshot());
    restored.applyRemote([ops[0]!]);
    expect(restored.text()).toBe('xy');
  });
});
