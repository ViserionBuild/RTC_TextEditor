import { describe, expect, it } from 'vitest';
import { StabilityTracker } from '../src';

const none = new Set<string>();

describe('StabilityTracker', () => {
  it('publishes a collect only after the second round', () => {
    const t = new StabilityTracker(Infinity);
    t.observe('a', { a: 3 }, 0);
    t.observe('b', { a: 3, b: 2 }, 0);
    let u = t.advance(0, { a: 3, b: 2 }, none);
    expect(u.stable).toEqual({ a: 3 });
    expect(u.collect).toBeNull(); // candidate S = {a:3} opened; C = {a:3, b:2}

    t.observe('a', { a: 3, b: 1 }, 1);
    expect(t.advance(1, { a: 3, b: 2 }, none).collect).toBeNull(); // a lacks b's 2nd op

    t.observe('a', { b: 2 }, 2);
    u = t.advance(2, { a: 3, b: 2 }, none);
    expect(u.collect).toEqual({ vv: { a: 3 }, requires: { a: 3, b: 2 } });
    expect(t.collect).toEqual(u.collect);

    // The next frontier {a:3, b:2} completes at once: nobody wrote anything after seeing it.
    expect(t.advance(3, { a: 3, b: 2 }, none).collect).toEqual({
      vv: { a: 3, b: 2 },
      requires: { a: 3, b: 2 },
    });
    expect(t.advance(4, { a: 3, b: 2 }, none).collect).toBeNull(); // nothing new
  });

  it('waits for a newcomer to see the frontier before collecting', () => {
    const t = new StabilityTracker(Infinity);
    t.observe('a', { a: 2 }, 0);
    t.advance(0, { a: 2 }, none); // candidate {a:2}
    t.observe('n', { n: 1 }, 1); // newcomer with one offline op
    expect(t.advance(1, { a: 2, n: 1 }, none).collect).toBeNull();
    expect(t.stable).toEqual({});

    t.observe('n', { a: 2, n: 1 }, 2);
    t.observe('a', { n: 1 }, 2);
    expect(t.advance(2, { a: 2, n: 1 }, none).collect).toEqual({
      vv: { a: 2 },
      requires: { a: 2, n: 1 },
    });
  });

  it('evicts stale disconnected members and requires their ops before collecting', () => {
    const t = new StabilityTracker(100);
    t.observe('a', { a: 1, z: 4 }, 0);
    t.observe('z', { a: 1, z: 2 }, 0); // z goes quiet, its last ops reached a but not its ack
    t.observe('a', { a: 1, z: 4 }, 150);
    let u = t.advance(150, { a: 1, z: 4 }, new Set(['a']));
    expect(u.evicted).toEqual(['z']);
    expect(t.isEvicted('z')).toBe(true);
    expect(u.stable).toEqual({ a: 1, z: 4 });
    u = t.advance(151, { a: 1, z: 4 }, new Set(['a']));
    expect(u.collect).toEqual({ vv: { a: 1, z: 4 }, requires: { a: 1, z: 4 } });

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
