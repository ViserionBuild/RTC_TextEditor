import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doc } from '@collabpad/crdt';
import { SyncClient } from '@collabpad/client';
import { buildRelay, type Relay, type RelayConfig } from '../src';

export interface Running extends Relay {
  readonly http: string;
  readonly ws: string;
  readonly port: number;
}

export const tempDbPath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'collabpad-')), 'test.sqlite');

export async function startRelay(overrides: Partial<RelayConfig> = {}): Promise<Running> {
  const relay = await buildRelay({
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    maxMessageBytes: 256 * 1024,
    rateLimit: { perSecond: 1000, burst: 1000 },
    replicaLeaseMs: 60_000,
    corsOrigin: true,
    logLevel: 'silent',
    ...overrides,
  });
  await relay.app.listen({ port: overrides.port ?? 0, host: '127.0.0.1' });
  const address = relay.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    ...relay,
    port: address.port,
    http: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}/ws`,
  };
}

export async function createDoc(relay: Running, title?: string): Promise<string> {
  const res = await fetch(`${relay.http}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  return ((await res.json()) as { id: string }).id;
}

export function client(
  relay: Running,
  docId: string,
  replica: string,
  doc = new Doc(replica),
): SyncClient {
  const c = new SyncClient({
    url: relay.ws,
    docId,
    doc,
    backoffInitialMs: 20,
    backoffMaxMs: 100,
    syncIntervalMs: 200,
    seenDelayMs: 20,
  });
  c.connect();
  return c;
}

/** Local edit + submit, the way the editor binding will do it. */
export const type = (c: SyncClient, index: number, text: string): void =>
  c.submit(c.doc.insertAt(index, text));
export const erase = (c: SyncClient, index: number, length: number): void =>
  c.submit(c.doc.deleteRange(index, length));

export async function waitFor(
  check: () => boolean,
  label = 'condition',
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const converged = (clients: SyncClient[]): boolean =>
  clients.every(
    (c) =>
      c.status === 'online' && c.pending === 0 && c.doc.fullHash() === clients[0]!.doc.fullHash(),
  );

/** Open a raw socket and collect server frames. */
export async function rawSocket(url: string) {
  const ws = new WebSocket(url);
  const frames: { kind: string; [k: string]: unknown }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') frames.push(JSON.parse(e.data));
    else frames.push({ kind: 'binary-ops' });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => resolve());
    void closed.then(() => resolve(), reject);
  });
  return { ws, frames, closed };
}
