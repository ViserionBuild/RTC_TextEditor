import { describe, expect, it } from 'vitest';
import { Doc, rebaseUnacked, type Collect, type DocSnapshotV1, type Op } from '../src';
import { syncAll } from './helpers';

const all = (docs: Doc[]): Collect => ({
  vv: docs[0]!.versionVector(),
  requires: docs[0]!.versionVector(),
});

describe('Doc.collect', () => {
  it('purges stable tombstones without changing the visible text', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'hello world');
    a.deleteRange(1, 4); // "h world"
    syncAll([a, b]);

    const before = { text: b.text(), live: b.liveHash() };
    expect(a.collect(all([a]))).toBe(4);
    expect(a.stats()).toMatchObject({ visible: 7, tombstones: 0, elements: 7, ops: 0 });
    expect({ text: a.text(), live: a.liveHash() }).toEqual(before);
    expect(a.fullHash()).not.toBe(b.fullHash()); // b still holds the tombstones

    // Collected and uncollected replicas keep converging.
    a.insertAt(1, 'ey');
    b.insertAt(7, '!');
    b.deleteRange(0, 1);
    syncAll([a, b]);
    expect(a.text()).toBe(b.text());
    expect(a.liveHash()).toBe(b.liveHash());
  });

  it('does nothing until the replica has integrated everything required', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'xy');
    a.deleteRange(0, 1);
    b.applyRemote(a.opsSince({}).slice(0, 2));
    expect(b.collect(all([a]))).toBe(0);
  });

  it('keeps a tombstone whose right neighbour is newer than the GC frontier', () => {
    // The trap: purging `e` here would let a later concurrent insert scan past e's slot.
    const [a, b, c] = [new Doc('a'), new Doc('b'), new Doc('c')];
    const deliver = (to: Doc, ops: Op[]) => to.applyRemote(ops);

    const o = a.insertAt(0, 'O');
    deliver(b, o);
    deliver(c, o);
    const e = b.insertAt(1, 'e'); // child of O
    deliver(a, e);
    deliver(c, e);

    const del = c.deleteRange(1, 1); // c deletes e …
    deliver(a, del);
    // … while b, not having seen it, ages its clock and types Y right after e.
    const filler: Op[] = [];
    for (let i = 0; i < 20; i++) filler.push(...b.insertAt(2, 'f'), ...b.deleteRange(2, 1));
    const y = b.insertAt(2, 'Y');
    deliver(b, del);

    // Frontier S = {O, e, delete}; a saw S before Y existed, so a's next op is "after S".
    const S = { a: 1, b: 1, c: 1 };
    const n = a.insertAt(1, 'N'); // origin O, small stamp, concurrent with Y

    // c gets everything except N, then is told it may collect within S.
    for (const d of [c]) deliver(d, [...filler, ...y]);
    const requires = { a: 1, b: b.versionVector().b!, c: 1 };
    const uncollected = Doc.load('c2', c.snapshot());
    c.collect({ vv: S, requires });
    expect(c.stats().tombstones).toBeGreaterThanOrEqual(1); // e kept: its neighbour Y is new

    deliver(c, n);
    deliver(uncollected, n);
    expect(c.text()).toBe(uncollected.text());
    deliver(a, [...filler, ...y]);
    expect(a.text()).toBe(c.text());
  });

  it('snapshots collected state and keeps working after a reload', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'abcdef');
    b.applyRemote(a.opsSince({}));
    b.deleteRange(2, 2);
    syncAll([a, b]);
    a.collect(all([a]));

    const reloaded = Doc.load('a', JSON.parse(JSON.stringify(a.snapshot())));
    expect(reloaded.text()).toBe('abef');
    expect(reloaded.stats()).toEqual(a.stats());
    b.applyRemote(reloaded.insertAt(2, 'Z'));
    expect(b.text()).toBe('abZef');
    expect(reloaded.opsSince(b.versionVector())).toEqual([]);
  });

  it('bootstraps an empty doc from a state snapshot', () => {
    const a = new Doc('a');
    a.insertAt(0, 'hello');
    a.deleteRange(0, 1);
    const fresh = new Doc('n');
    expect(fresh.adoptState(a.snapshot())).toEqual({ type: 'insert', index: 0, text: 'ello' });
    expect(fresh.versionVector()).toEqual(a.versionVector());
    expect(() => fresh.adoptState(a.snapshot())).toThrow(/empty/);
    expect(new Doc('m').adoptState(new Doc('z').snapshot())).toBeNull();
    a.applyRemote(fresh.insertAt(4, '!'));
    expect(a.text()).toBe('ello!');
  });

  it('still loads legacy op-log snapshots', () => {
    const a = new Doc('a');
    const ops = a.insertAt(0, 'hi');
    const legacy: DocSnapshotV1 = { version: 1, lamport: 2, log: { a: ops }, pending: [] };
    expect(Doc.load('a', legacy).text()).toBe('hi');
  });
});

describe('rebaseUnacked', () => {
  it('replays offline edits of an evicted replica onto a fresh replica', () => {
    const [a, old] = [new Doc('a'), new Doc('old')];
    a.insertAt(0, 'The fox jumps');
    syncAll([a, old]);
    const acked = old.versionVector();

    // old goes offline for too long: types and deletes, including deleting its own new text.
    old.insertAt(4, 'quick brown '); // "The quick brown fox jumps"
    old.deleteRange(4, 6); // removes its own "quick " → "The brown fox jumps"
    old.deleteRange(old.length - 5, 5); // deletes "jumps" (acked text)
    old.insertAt(old.length, 'runs');

    // Meanwhile everyone else edits and garbage-collects.
    a.insertAt(0, '> ');
    a.deleteRange(6, 1); // removes "f": "> The ox jumps"
    a.collect({ vv: a.versionVector(), requires: a.versionVector() });

    const fresh = Doc.load('new', a.snapshot());
    const ops = rebaseUnacked(old, acked, fresh);
    a.applyRemote(ops);
    expect(fresh.text()).toBe(a.text());
    expect(a.text()).toBe('> The brown ox runs');
    expect(ops.every((op) => op.id.replica === 'new')).toBe(true);
  });

  it('produces nothing when everything was acknowledged', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'abc');
    syncAll([a, b]);
    expect(rebaseUnacked(a, a.versionVector(), b)).toEqual([]);
  });
});
