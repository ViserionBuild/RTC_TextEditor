import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDoc, startRelay, type Running } from './helpers';

let relay: Running;
beforeEach(async () => (relay = await startRelay()));
afterEach(() => relay.app.close());

describe('REST API', () => {
  it('creates, reads and renames documents', async () => {
    expect(await (await fetch(`${relay.http}/healthz`)).json()).toEqual({ ok: true });

    const id = await createDoc(relay, 'Notes');
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const meta = await (await fetch(`${relay.http}/api/docs/${id}`)).json();
    expect(meta).toMatchObject({ id, title: 'Notes' });

    const renamed = await fetch(`${relay.http}/api/docs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Plans' }),
    });
    expect(await renamed.json()).toMatchObject({ title: 'Plans' });

    const stats = await (await fetch(`${relay.http}/api/docs/${id}/stats`)).json();
    expect(stats).toMatchObject({ docId: id, connections: 0, ops: 0 });
  });

  it('defaults the title and 404s unknown docs', async () => {
    const res = await fetch(`${relay.http}/api/docs`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: 'Untitled' });
    for (const [method, path] of [
      ['GET', '/api/docs/nope'],
      ['GET', '/api/docs/nope/stats'],
      ['PATCH', '/api/docs/nope'],
    ] as const) {
      const r = await fetch(`${relay.http}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'PATCH' ? JSON.stringify({ title: 'x' }) : undefined,
      });
      expect(r.status).toBe(404);
    }
  });

  it('validates titles', async () => {
    const id = await createDoc(relay);
    const r = await fetch(`${relay.http}/api/docs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(r.status).toBe(400);
  });
});
