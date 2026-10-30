import type { SyncClient } from '@collabpad/client';
import { Doc } from '@collabpad/crdt';
import { encode } from '@collabpad/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  client,
  converged,
  createDoc,
  erase,
  startRelay,
  tempDbPath,
  type,
  waitFor,
  type Running,
} from './helpers';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function relayWith(overrides: Parameters<typeof startRelay>[0] = {}) {
  const relay = await startRelay(overrides);
  cleanup.push(() => relay.app.close());
  return relay;
}

function connect(relay: Running, docId: string, replica: string, doc?: Doc): SyncClient {
  const c = client(relay, docId, replica, doc);
  cleanup.push(() => c.disconnect());
  return c;
}

const stats = async (relay: Running, docId: string) =>
  (await (await fetch(`${relay.http}/api/docs/${docId}/stats`)).json()) as Record<string, unknown>;

const noTombstones = (clients: SyncClient[]) =>
  clients.every((c) => c.doc.stats().tombstones === 0);

describe('tombstone garbage collection through the relay', () => {
  it('collects deleted text on every client and on the relay', async () => {
    const relay = await relayWith();
    const docId = await createDoc(relay);
    const clients = ['a', 'b', 'c'].map((r) => connect(relay, docId, r));
    const [a, b, c] = clients as [SyncClient, SyncClient, SyncClient];
    await waitFor(() => clients.every((x) => x.status === 'online'));

    type(a, 0, 'hello brave new world');
    await waitFor(() => converged(clients));
    erase(b, 5, 10);
    await waitFor(() => converged(clients) && noTombstones(clients), 'GC on all clients');
    expect(c.doc.text()).toBe('hello world');
    expect(await stats(relay, docId)).toMatchObject({ tombstones: 0, visible: 11 });

    // Editing continues normally after collection.
    type(c, 5, ',');
    erase(a, 0, 1);
    await waitFor(() => converged(clients) && a.doc.text() === 'ello, world');
  });

  it('bootstraps a new client from a compact snapshot instead of the full history', async () => {
    const relay = await relayWith();
    const docId = await createDoc(relay);
    const a = connect(relay, docId, 'a');
    type(a, 0, 'x'.repeat(500));
    await waitFor(() => a.pending === 0);
    erase(a, 0, 490);
    const b = connect(relay, docId, 'b');
    await waitFor(() => converged([a, b]) && noTombstones([a, b]), 'collected');

    const fresh = connect(relay, docId, 'fresh');
    await waitFor(() => fresh.doc.text() === 'x'.repeat(10), 'bootstrap');
    expect(fresh.doc.stats()).toMatchObject({ visible: 10, tombstones: 0, ops: 0 });
    const allOps = (await stats(relay, docId)).ops as number;
    expect(allOps).toBe(990);
    // What a new client would download without snapshots: every op ever written.
    const historyBytes = new TextEncoder().encode(
      encode({ kind: 'ops', ops: a.doc.opsSince({}) }),
    ).length;
    expect(a.doc.opsSince({})).toHaveLength(0); // a pruned its log after GC, so rebuild it:
    const full = new Doc('full');
    full.insertAt(0, 'x'.repeat(500));
    full.deleteRange(0, 490);
    const fullBytes = new TextEncoder().encode(
      encode({ kind: 'ops', ops: full.opsSince({}) }),
    ).length;
    expect(historyBytes).toBeLessThan(fullBytes);
    expect(fresh.bytes.received * 20).toBeLessThan(fullBytes);

    type(fresh, 10, '!');
    await waitFor(() => a.doc.text().endsWith('!'));
  });

  it('evicts a replica gone longer than the lease; on return it rejoins and keeps its edits', async () => {
    let now = 1_000_000;
    const relay = await relayWith({ replicaLeaseMs: 60_000, now: () => now });
    const docId = await createDoc(relay);
    const a = connect(relay, docId, 'a');
    const old = connect(relay, docId, 'old');
    type(a, 0, 'shared text');
    await waitFor(() => converged([a, old]));

    old.disconnect();
    type(old, 6, 'offline '); // unacked edits made while away
    now += 120_000; // longer than the lease
    erase(a, 0, 7); // a's activity lets the relay notice old is gone, then GC proceeds
    await waitFor(() => a.doc.stats().tombstones === 0, 'GC no longer waits for old');
    expect(await stats(relay, docId)).toMatchObject({ evicted: 1, members: 1 });

    const rejoin = new Promise<void>((resolve) => old.on('rejoin', resolve));
    old.connect();
    await rejoin;
    const next = await old.rejoinAs('old-2');
    cleanup.push(() => next.disconnect());
    await waitFor(() => converged([a, next]), 'rejoined');
    expect(a.doc.text()).toBe('offline text');
  });

  it('makes an unknown replica with offline edits rejoin once GC has started', async () => {
    const relay = await relayWith();
    const docId = await createDoc(relay);
    const a = connect(relay, docId, 'a');
    type(a, 0, 'abc');
    erase(a, 0, 1);
    await waitFor(() => a.doc.stats().tombstones === 0, 'collected');

    const stranger = new Doc('stranger');
    stranger.insertAt(0, 'typed before ever syncing');
    const s = connect(relay, docId, 'stranger', stranger);
    await new Promise<void>((resolve) => s.on('rejoin', resolve));
    const next = await s.rejoinAs('stranger-2');
    cleanup.push(() => next.disconnect());
    await waitFor(() => converged([a, next]) && a.doc.text().includes('typed before ever syncing'));
  });

  it('keeps the collected state and GC permission across a relay restart', async () => {
    const dbPath = tempDbPath();
    const first = await startRelay({ dbPath });
    const docId = await createDoc(first);
    const a = client(first, docId, 'a');
    type(a, 0, 'keep this, drop that');
    erase(a, 10, 10);
    await waitFor(() => a.doc.stats().tombstones === 0, 'collected');
    a.disconnect();
    await first.app.close();

    const second = await relayWith({ dbPath });
    expect(await stats(second, docId)).toMatchObject({ tombstones: 0, visible: 10 });
    const fresh = connect(second, docId, 'fresh');
    await waitFor(() => fresh.doc.text() === 'keep this,');
    expect(fresh.doc.stats().tombstones).toBe(0);
  });
});
