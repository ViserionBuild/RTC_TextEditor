import type { SyncClient } from '@collabpad/client';
import { Doc } from '@collabpad/crdt';
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

async function setup(dbPath?: string) {
  const relay = await startRelay(dbPath ? { dbPath } : {});
  cleanup.push(() => relay.app.close());
  const docId = await createDoc(relay);
  return { relay, docId };
}

function three(relay: Running, docId: string): SyncClient[] {
  const clients = ['alice', 'bob', 'carol'].map((r) => client(relay, docId, r));
  cleanup.push(() => clients.forEach((c) => c.disconnect()));
  return clients;
}

describe('relay with three clients', () => {
  it('forwards live edits between all clients', async () => {
    const { relay, docId } = await setup();
    const [a, b, c] = three(relay, docId);
    await waitFor(() => [a, b, c].every((x) => x!.status === 'online'), 'online');

    type(a!, 0, 'hello');
    await waitFor(() => b!.doc.text() === 'hello' && c!.doc.text() === 'hello', 'propagation');
    type(b!, 5, ' world');
    erase(c!, 0, 1);
    await waitFor(() => converged([a!, b!, c!]), 'convergence');
    expect(a!.doc.text()).toBe('ello world');

    const stats = await (await fetch(`${relay.http}/api/docs/${docId}/stats`)).json();
    expect(stats).toMatchObject({ connections: 3, ops: 12 });
    expect(stats.bytesIn).toBeGreaterThan(0);
    expect(stats.bytesOut).toBeGreaterThan(stats.bytesIn);
  });

  it('merges offline edits on reconnect and sends only the missing ops', async () => {
    const { relay, docId } = await setup();
    const [a, b, c] = three(relay, docId);
    await waitFor(() => [a, b, c].every((x) => x!.status === 'online'), 'online');
    type(a!, 0, 'shared');
    await waitFor(() => converged([a!, b!, c!]), 'initial sync');

    b!.disconnect();
    type(b!, 6, ' offline');
    type(a!, 0, '>');
    await waitFor(() => c!.doc.text() === '>shared', 'c sees a');
    erase(c!, 1, 1);
    expect(b!.pending).toBe(8);
    await waitFor(() => a!.doc.text() === c!.doc.text(), 'a/c sync');

    const before = b!.bytes.received;
    b!.connect();
    await waitFor(() => converged([a!, b!, c!]), 'reconvergence');
    expect(b!.pending).toBe(0);
    expect(a!.doc.text()).toBe('>hared offline');
    // b only downloads a's 1 insert and c's 1 delete, not the whole document.
    expect(b!.bytes.received - before).toBeLessThan(1000);
  });

  it('QA-6 end to end: insert next to a concurrently deleted character', async () => {
    const { relay, docId } = await setup();
    const [a, b] = three(relay, docId);
    type(a!, 0, 'cat');
    await waitFor(() => b!.doc.text() === 'cat', 'seed');
    a!.disconnect();
    b!.disconnect();
    erase(a!, 1, 1);
    type(b!, 2, 'r');
    a!.connect();
    b!.connect();
    await waitFor(() => converged([a!, b!]) && a!.doc.text() === 'crt', 'crt');
  });

  it('QA-10: survives a relay restart without losing acknowledged ops', async () => {
    const dbPath = tempDbPath();
    const first = await startRelay({ dbPath });
    const docId = await createDoc(first);
    const [a, b, c] = three(first, docId);
    type(a!, 0, 'before restart. ');
    await waitFor(() => converged([a!, b!, c!]), 'pre-restart sync');

    await first.app.close();
    await waitFor(() => [a, b, c].every((x) => x!.status !== 'online'), 'clients notice outage');
    type(b!, 0, '[b offline] ');
    type(c!, c!.doc.length, '[c offline]');

    const second = await startRelay({ dbPath, port: first.port });
    cleanup.push(() => second.app.close());
    await waitFor(() => converged([a!, b!, c!]), 'post-restart convergence');
    expect(a!.doc.text()).toBe('[b offline] before restart. [c offline]');

    // A brand-new client loads everything from the persisted log.
    const late = client(second, docId, 'dave');
    cleanup.push(() => late.disconnect());
    await waitFor(() => late.doc.text() === a!.doc.text(), 'late joiner');
  });

  it('restores a client that reloads with its saved snapshot', async () => {
    const { relay, docId } = await setup();
    const a = client(relay, docId, 'a');
    cleanup.push(() => a.disconnect());
    type(a, 0, 'abc');
    await waitFor(() => a.pending === 0, 'acked');
    a.disconnect();
    type(a, 3, 'def'); // typed offline, then the "tab reloads"
    const restored = client(
      relay,
      docId,
      'a',
      Doc.load('a', JSON.parse(JSON.stringify(a.doc.snapshot()))),
    );
    cleanup.push(() => restored.disconnect());
    await waitFor(() => restored.pending === 0, 'offline ops delivered');
    const fresh = client(relay, docId, 'z');
    cleanup.push(() => fresh.disconnect());
    await waitFor(() => fresh.doc.text() === 'abcdef', 'fresh client');
  });

  it('advances the stable vector once every replica has seen an op', async () => {
    const { relay, docId } = await setup();
    const [a, b, c] = three(relay, docId);
    const stable: Record<string, number>[] = [];
    c!.on('stable', (vv) => stable.push(vv));
    type(a!, 0, 'xyz');
    await waitFor(() => converged([a!, b!, c!]), 'sync');
    // Periodic sync (200 ms in tests) reports each client's vector to the relay.
    await waitFor(() => (stable.at(-1)?.alice ?? 0) === 3, 'stable advanced');
  });
});

describe('large batches', () => {
  it('syncs a 25,000-character paste and catches up a client that is far behind', async () => {
    const { relay, docId } = await setup();
    const a = client(relay, docId, 'paster');
    const b = client(relay, docId, 'reader');
    cleanup.push(() => [a, b].forEach((c) => c.disconnect()));
    await waitFor(() => a.status === 'online' && b.status === 'online', 'online');

    // More ops than one frame may carry: must be split, not rejected.
    type(a, 0, 'lorem ipsum '.repeat(2100).slice(0, 25_000));
    await waitFor(() => b.doc.length === 25_000 && a.pending === 0, 'paste delivered', 15_000);

    // Saw only the first character, then returns: catch-up is also more than one frame.
    const behind = new Doc('returning');
    behind.applyRemote(a.doc.opsSince({}).slice(0, 1));
    const r = client(relay, docId, 'returning', behind);
    cleanup.push(() => r.disconnect());
    await waitFor(() => r.doc.text() === a.doc.text(), 'far-behind client caught up', 15_000);
  });
});
