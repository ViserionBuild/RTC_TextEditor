import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LamportClock,
  compareStamps,
  idEquals,
  sha256Hex,
  vvDominates,
  vvEquals,
  vvMerge,
  vvMin,
} from '../src';

describe('LamportClock', () => {
  it('ticks and observes', () => {
    const c = new LamportClock();
    expect(c.tick()).toBe(1);
    c.observe(10);
    expect(c.tick()).toBe(11);
    c.observe(3);
    expect(c.value).toBe(11);
  });
});

describe('ids', () => {
  it('orders stamps by lamport then replica', () => {
    expect(compareStamps({ lamport: 1, replica: 'z' }, { lamport: 2, replica: 'a' })).toBeLessThan(
      0,
    );
    expect(
      compareStamps({ lamport: 2, replica: 'b' }, { lamport: 2, replica: 'a' }),
    ).toBeGreaterThan(0);
    expect(compareStamps({ lamport: 2, replica: 'a' }, { lamport: 2, replica: 'a' })).toBe(0);
  });

  it('compares ids', () => {
    expect(idEquals(null, null)).toBe(true);
    expect(idEquals({ replica: 'a', seq: 1 }, null)).toBe(false);
    expect(idEquals({ replica: 'a', seq: 1 }, { replica: 'a', seq: 1 })).toBe(true);
    expect(idEquals({ replica: 'a', seq: 1 }, { replica: 'a', seq: 2 })).toBe(false);
  });
});

describe('version vectors', () => {
  it('merges, dominates, mins', () => {
    const a = { x: 3, y: 1 };
    const b = { x: 1, z: 4 };
    expect(vvMerge(a, b)).toEqual({ x: 3, y: 1, z: 4 });
    expect(vvDominates(vvMerge(a, b), a)).toBe(true);
    expect(vvDominates(a, b)).toBe(false);
    expect(vvEquals({ x: 1 }, { x: 1 })).toBe(true);
    expect(vvMin([a, b])).toEqual({ x: 1 });
    expect(vvMin([])).toEqual({});
  });
});

describe('sha256Hex', () => {
  it.each(['', 'abc', 'héllo wörld 🌍', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56)])(
    'matches node crypto for %#',
    (input) => {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input).digest('hex'));
    },
  );
});
