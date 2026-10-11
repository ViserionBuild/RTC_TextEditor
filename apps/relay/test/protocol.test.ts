import { Doc } from '@collabpad/crdt';
import { CloseCode } from '@collabpad/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { client, createDoc, rawSocket, startRelay, waitFor, type Running } from './helpers';

let relay: Running;
afterEach(() => relay?.app.close());

const hello = (replica: string) => JSON.stringify({ kind: 'hello', replica, vv: {} });

describe('relay protocol enforcement', () => {
  it('closes connections to unknown documents (client stops retrying)', async () => {
    relay = await startRelay();
    const c = client(relay, 'missing', 'a');
    const fatal = new Promise<string>((resolve) => c.on('fatal', resolve));
    expect(await fatal).toBe('unknown document');
    expect(c.status).toBe('offline');
  });

  it.each([
    ['invalid JSON', ['{'], 'bad-message'],
    ['ops before hello', [JSON.stringify({ kind: 'sync', vv: {} })], 'not-hello'],
    ['second hello', [hello('a'), hello('a')], 'bad-message'],
  ])('rejects %s', async (_, frames, code) => {
    relay = await startRelay();
    const docId = await createDoc(relay);
    const s = await rawSocket(`${relay.ws}?doc=${docId}`);
    for (const f of frames) s.ws.send(f);
    expect((await s.closed).code).toBe(CloseCode.PolicyViolation);
    expect(s.frames.at(-1)).toMatchObject({ kind: 'error', code });
  });

  it('rejects ops forged on behalf of another replica', async () => {
    relay = await startRelay();
    const docId = await createDoc(relay);
    const s = await rawSocket(`${relay.ws}?doc=${docId}`);
    s.ws.send(hello('mallory'));
    s.ws.send(JSON.stringify({ kind: 'ops', ops: new Doc('alice').insertAt(0, 'x') }));
    expect((await s.closed).code).toBe(CloseCode.PolicyViolation);
    expect(s.frames.at(-1)).toMatchObject({ kind: 'error', code: 'forged-op' });
  });

  it('rejects binary frames', async () => {
    relay = await startRelay();
    const docId = await createDoc(relay);
    const s = await rawSocket(`${relay.ws}?doc=${docId}`);
    s.ws.send(new Uint8Array([1, 2, 3]));
    expect((await s.closed).code).toBe(CloseCode.PolicyViolation);
  });

  it('rate-limits floods', async () => {
    relay = await startRelay({ rateLimit: { perSecond: 1, burst: 5 } });
    const docId = await createDoc(relay);
    const s = await rawSocket(`${relay.ws}?doc=${docId}`);
    s.ws.send(hello('a'));
    for (let i = 0; i < 10; i++) s.ws.send(JSON.stringify({ kind: 'sync', vv: {} }));
    expect((await s.closed).code).toBe(CloseCode.RateLimited);
  });

  it('caps message size', async () => {
    relay = await startRelay({ maxMessageBytes: 1024 });
    const docId = await createDoc(relay);
    const s = await rawSocket(`${relay.ws}?doc=${docId}`);
    s.ws.send('x'.repeat(2048));
    expect((await s.closed).code).toBe(CloseCode.TooLarge);
  });

  it('replaces an older connection for the same replica', async () => {
    relay = await startRelay();
    const docId = await createDoc(relay);
    const first = client(relay, docId, 'a');
    const fatal = new Promise<string>((resolve) => first.on('fatal', resolve));
    await waitFor(() => first.status === 'online');
    const second = client(relay, docId, 'a');
    expect(await fatal).toMatch(/replaced/);
    await waitFor(() => second.status === 'online');
    second.disconnect();
  });
});

describe('presence', () => {
  it('forwards cursors, replays them to late joiners and announces departures', async () => {
    relay = await startRelay();
    const docId = await createDoc(relay);
    const a = client(relay, docId, 'a');
    const b = client(relay, docId, 'b');
    await waitFor(() => a.status === 'online' && b.status === 'online');

    const presence = { name: 'Alice', color: '#ff0066', anchor: null, head: null };
    a.setPresence(presence);
    await waitFor(() => b.peerPresence.get('a')?.name === 'Alice', 'presence to b');

    const c = client(relay, docId, 'c');
    await waitFor(() => c.peerPresence.has('a'), 'presence replayed to c');

    const left: string[] = [];
    b.on('presence', (replica, p) => p === null && left.push(replica));
    a.disconnect();
    await waitFor(() => left.includes('a'), 'presence-left');
    b.disconnect();
    c.disconnect();
  });
});
