import { Doc } from '@collabpad/crdt';
import { describe, expect, it } from 'vitest';
import { Store } from '../src';
import { tempDbPath } from './helpers';

describe('Store', () => {
  it('appends idempotently and persists across reopen', () => {
    const path = tempDbPath();
    const store = new Store(path);
    const { id } = store.createDoc();
    const ops = new Doc('a').insertAt(0, 'abc');
    store.appendOps(id, ops);
    store.appendOps(id, ops);
    store.saveAck(id, { replica: 'a', vv: { a: 3 }, lastSeen: 1 });
    store.close();

    const reopened = new Store(path);
    expect(reopened.loadOps(id)).toEqual(ops);
    expect(reopened.loadAcks(id)).toEqual([{ replica: 'a', vv: { a: 3 }, lastSeen: 1 }]);
    expect(reopened.getDoc('missing')).toBeUndefined();
    expect(reopened.renameDoc('missing', 'x')).toBe(false);
    reopened.close();
  });

  it('rolls back a failed transaction', () => {
    const store = new Store(':memory:');
    const { id } = store.createDoc();
    const ops = new Doc('a').insertAt(0, 'ab');
    const bad = { ...ops[1]!, id: { replica: 'a', seq: 2n as unknown as number } };
    expect(() => store.appendOps(id, [ops[0]!, bad])).toThrow();
    expect(store.loadOps(id)).toEqual([]);
  });
});
