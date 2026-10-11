import { describe, expect, it } from 'vitest';
import { Doc, OpLog } from '../src';

describe('OpLog', () => {
  it('keeps replicas contiguous, holds gaps and drops duplicates', () => {
    const a = new Doc('a');
    const ops = a.insertAt(0, 'abc');
    const log = new OpLog();

    expect(log.add([ops[2]!, ops[1]!])).toEqual([]);
    expect(log.waiting).toBe(2);
    expect(log.add([ops[0]!, ops[0]!])).toEqual(ops);
    expect(log.waiting).toBe(0);
    expect(log.add(ops)).toEqual([]);
    expect(log.size).toBe(3);
    expect(log.versionVector()).toEqual({ a: 3 });
    expect(log.since({ a: 1 })).toEqual(ops.slice(1));
    expect(log.since({})).toEqual(ops);
  });
});
