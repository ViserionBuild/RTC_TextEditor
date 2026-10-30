/**
 * Three headless clients edit one document through a real relay. Bob goes offline, everyone
 * keeps typing, Bob reconnects, and all three converge to the same SHA-256 hash.
 *
 *   pnpm demo:3clients
 */
import { SyncClient } from '@collabpad/client';
import { Doc } from '@collabpad/crdt';
import { buildRelay } from '../src';

const relay = await buildRelay({
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  maxMessageBytes: 256 * 1024,
  rateLimit: { perSecond: 1000, burst: 1000 },
  replicaLeaseMs: 60_000,
  corsOrigin: true,
  logLevel: 'warn',
});
await relay.app.listen({ port: 0, host: '127.0.0.1' });
const { port } = relay.app.server.address() as { port: number };
const docId = relay.store.createDoc('Demo').id;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(150);
const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((name) => {
  const c = new SyncClient({ url: `ws://127.0.0.1:${port}/ws`, docId, doc: new Doc(name) });
  c.connect();
  return c;
}) as [SyncClient, SyncClient, SyncClient];
const all = [alice, bob, carol];
const type = (c: SyncClient, i: number, t: string) => c.submit(c.doc.insertAt(i, t));

const show = (title: string) => {
  console.log(`\n── ${title}`);
  for (const c of all) {
    const status = c.status.padEnd(10);
    const pending = c.pending ? ` (${c.pending} pending)` : '';
    console.log(
      `  ${c.doc.replica.padEnd(6)} ${status} ${c.doc.stateHash().slice(0, 12)}  ${JSON.stringify(c.doc.text())}${pending}`,
    );
  }
};

await settle();
type(alice, 0, 'The quick fox.');
await settle();
show('alice types; everyone receives it');

bob.disconnect();
type(bob, 10, 'brown ');
type(alice, 4, 'very ');
carol.submit(carol.doc.deleteRange(carol.doc.length - 1, 1));
type(carol, carol.doc.length, '!');
await settle();
show('bob goes offline; all three keep editing');

bob.connect();
await settle();
show('bob reconnects: version vectors exchanged, only missing ops sent');

const hashes = new Set(all.map((c) => c.doc.stateHash()));
console.log(
  `\n${hashes.size === 1 ? '✔ converged' : '✘ DIVERGED'} — ${hashes.size} distinct hash(es)`,
);
console.log('relay stats:', relay.rooms.get(docId)?.stats());
for (const c of all) c.disconnect();
await relay.app.close();
process.exit(hashes.size === 1 ? 0 : 1);
