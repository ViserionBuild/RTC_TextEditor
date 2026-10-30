import { describe, expect, it } from 'vitest';
import { StabilityTracker } from '../src';

const none = new Set<string>();

describe('StabilityTracker', () => {
  it('round 2 waits until everyone has the ops written before seeing the frontier', () => {
    const t = new StabilityTracker(Infinity);
    t.observe('a', { a: 3 }, 0);
    t.observe('b', { a: 3, b: 2 }, 0); // b wrote 2 ops; a has not received them
    let u = t.advance(0, { a: 3, b: 2 }, none);
    expect(u.stable).toEqual({ a: 3 });
    expect(u.collect).toBeNull(); // round opened at S = {a:3}; requires b's 2 ops everywhere

    t.observe('a', { b: 1 }, 1);
    expect(t.advance(1, { a: 3, b: 2 }, none).collect).toBeNull();

    t.observe('b', { b: 3 }, 2); // b writes again after seeing S: not required this round
    t.observe('a', { b: 2 }, 2);
    u = t.advance(2, { a: 3, b: 3 }, none);
    expect(u.collect).toEqual({ vv: { a: 3 }, requires: { a: 3, b: 2 } });
    expect(t.collect).toEqual(u.collect);
    expect(t.advance(3, { a: 3, b: 3 }, none).collect).toBeNull(); // next round needs b:3 at a

    // Once a has b:3 the open round completes, and the next (nothing new written) completes
    // in the same step, so the published permission jumps straight to the latest frontier.
    t.observe('a', { b: 3 }, 4);
    expect(t.advance(4, { a: 3, b: 3 }, none).collect).toEqual({
      vv: { a: 3, b: 3 },
      requires: { a: 3, b: 3 },
    });
  });

  it('completes a round immediately when nobody wrote anything after the frontier', () => {
    const t = new StabilityTracker(Infinity);
    t.observe('a', { a: 2, b: 1 }, 0);
    t.observe('b', { a: 2, b: 1 }, 0);
    expect(t.advance(0, { a: 2, b: 1 }, none).collect).toEqual({
      vv: { a: 2, b: 1 },
      requires: { a: 2, b: 1 },
    });
  });

  it('waits for a newcomer to see the frontier before collecting', () => {
    const t = new StabilityTracker(Infinity);
    t.observe('a', { a: 2 }, 0);
    t.observe('b', { a: 2, b: 1 }, 0);
    expect(t.advance(0, { a: 2, b: 1 }, none).collect).toBeNull(); // a lacks b:1
    t.observe('n', { n: 1 }, 1); // newcomer with one offline op joins mid-round
    t.observe('a', { b: 1 }, 1);
    expect(t.advance(1, { a: 2, b: 1, n: 1 }, none).collect).toBeNull();
    expect(t.stable).toEqual({});

    t.observe('n', { a: 2, b: 1 }, 2);
    t.observe('a', { n: 1 }, 2);
    t.observe('b', { n: 1 }, 2);
    const u = t.advance(2, { a: 2, b: 1, n: 1 }, none);
    expect(u.collect?.requires).toEqual({ a: 2, b: 1, n: 1 });
  });

  it('evicts stale disconnected members and requires their ops before collecting', () => {
    const t = new StabilityTracker(100);
    t.observe('a', { a: 1, z: 4 }, 0);
    t.observe('z', { a: 1, z: 2 }, 0); // z goes quiet, its last ops reached a but not its ack
    t.observe('a', { a: 1, z: 4 }, 150);
    const u = t.advance(150, { a: 1, z: 4 }, new Set(['a']));
    expect(u.evicted).toEqual(['z']);
    expect(t.isEvicted('z')).toBe(true);
    expect(u.stable).toEqual({ a: 1, z: 4 });
    expect(u.collect).toEqual({ vv: { a: 1, z: 4 }, requires: { a: 1, z: 4 } });
    expect(t.advance(151, { a: 1, z: 4 }, new Set(['a'])).collect).toBeNull();

    t.observe('z', { z: 9 }, 200); // ignored once evicted
    expect(t.records().find((r) => r.replica === 'z')!.vv).toEqual({ a: 1, z: 2 });
  });

  it('never evicts a connected replica', () => {
    const t = new StabilityTracker(10);
    t.observe('a', {}, 0);
    expect(t.advance(1000, {}, new Set(['a'])).evicted).toEqual([]);
  });

  it('admits fresh replicas but makes evicted or late offline authors rejoin', () => {
    const t = new StabilityTracker(10, {
      members: [{ replica: 'gone', vv: {}, lastSeen: 0, evicted: true }],
      collect: { vv: { a: 1 }, requires: { a: 1 } },
    });
    expect(t.admit('gone', {})).toBe('rejoin');
    expect(t.admit('stranger', { stranger: 3 })).toBe('rejoin');
    expect(t.admit('stranger', {})).toBe('ok');
    t.observe('m', { m: 1 }, 0);
    expect(t.admit('m', { m: 5 })).toBe('ok');
    expect(new StabilityTracker(10).admit('stranger', { stranger: 3 })).toBe('ok');
  });
});
