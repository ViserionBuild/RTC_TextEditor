import { DatabaseSync } from 'node:sqlite';
import { Doc } from '@collabpad/crdt';
import { describe, expect, it } from 'vitest';
import { Store } from '../src';
import { tempDbPath } from './helpers';

describe('Store', () => {
  it('appends idempotently and persists members, collect and snapshots across reopen', () => {
    const path = tempDbPath();
    const store = new Store(path);
    const { id } = store.createDoc();
    const doc = new Doc('a');
    const ops = doc.insertAt(0, 'abc');
    const member = { replica: 'a', vv: { a: 3 }, lastSeen: 1, evicted: false };
    store.appendOps(id, ops, [member]);
    store.appendOps(id, ops);
    store.saveMembers(id, [{ replica: 'z', vv: {}, lastSeen: 0, evicted: true }]);
    store.saveCollect(id, { vv: { a: 3 }, requires: { a: 3 } });
    store.saveSnapshot(id, doc.snapshot());
    store.close();

    const reopened = new Store(path);
    expect(reopened.loadOps(id)).toEqual(ops);
    expect(reopened.loadMembers(id)).toEqual([
      member,
      { replica: 'z', vv: {}, lastSeen: 0, evicted: true },
    ]);
    expect(reopened.loadCollect(id)).toEqual({ vv: { a: 3 }, requires: { a: 3 } });
    expect(Doc.load('a', reopened.loadSnapshot(id)!).text()).toBe('abc');
    expect(reopened.loadSnapshot('missing')).toBeNull();
    expect(reopened.loadCollect('missing')).toBeNull();
    expect(reopened.getDoc('missing')).toBeUndefined();
    expect(reopened.renameDoc('missing', 'x')).toBe(false);
    reopened.close();
  });

  it('upgrades a database created before GC existed', () => {
    const path = tempDbPath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE replica_acks (doc_id TEXT NOT NULL, replica TEXT NOT NULL, vv TEXT NOT NULL,
        last_seen INTEGER NOT NULL, PRIMARY KEY (doc_id, replica)) WITHOUT ROWID;
      INSERT INTO docs VALUES ('d', 'Old', 1);
      INSERT INTO replica_acks VALUES ('d', 'a', '{"a":2}', 5);
    `);
    old.close();
    const store = new Store(path);
    expect(store.loadMembers('d')).toEqual([
      { replica: 'a', vv: { a: 2 }, lastSeen: 5, evicted: false },
    ]);
    expect(store.loadCollect('d')).toBeNull();
    store.close();
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
