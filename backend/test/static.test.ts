import { afterEach, describe, expect, it } from 'vitest';
import { startRelay, type Running } from './helpers';

let relay: Running;
afterEach(() => relay?.app.close());

describe('serving the web app', () => {
  it('serves the shell for client routes, caches assets, keeps API 404s as JSON', async () => {
    relay = await startRelay({ webDist: new URL('./fixtures/web', import.meta.url).pathname });

    const root = await fetch(`${relay.http}/`);
    expect(await root.text()).toContain('app shell');
    expect(root.headers.get('cache-control')).toBe('no-cache');

    const deep = await fetch(`${relay.http}/d/someDocId`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('app shell');

    const asset = await fetch(`${relay.http}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const api = await fetch(`${relay.http}/api/nope`);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'not found' });
    expect((await fetch(`${relay.http}/healthz`)).status).toBe(200);
  });
});
