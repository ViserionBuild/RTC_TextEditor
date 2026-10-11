import { describe, expect, it } from 'vitest';
import { Simulation } from '../src';

const three = (seed = 1, extra = {}) =>
  new Simulation({ seed, replicas: ['alice', 'bob', 'carol'], ...extra });

describe('scenarios over a simulated network with a relay', () => {
  it('propagates live edits through the relay', () => {
    const sim = three();
    sim.type('alice', 0, 'hello');
    sim.advance(100);
    expect(sim.doc('bob').text()).toBe('hello');
    expect(sim.doc('carol').text()).toBe('hello');
    sim.assertConverged();
  });

  it('QA-5: three offline replicas insert at the same position', () => {
    const sim = three(5);
    sim.type('alice', 0, 'Hello!');
    sim.settle();
    for (const r of sim.replicas) sim.disconnect(r);
    sim.type('alice', 5, ' Alice');
    sim.type('bob', 5, ' Bob');
    sim.type('carol', 5, ' Carol');
    for (const r of sim.replicas) sim.reconnect(r);
    sim.settle();
    sim.assertConverged();
    const text = sim.doc('carol').text();
    for (const w of [' Alice', ' Bob', ' Carol']) expect(text).toContain(w);
  });

  it('QA-6: insert next to a concurrently deleted character survives', () => {
    const sim = three(6);
    sim.type('alice', 0, 'cat');
    sim.settle();
    sim.disconnect('bob');
    sim.delete('alice', 1, 1);
    sim.type('bob', 2, 'r');
    sim.reconnect('bob');
    sim.settle();
    sim.assertConverged();
    expect(sim.doc('alice').text()).toBe('crt');
  });

  it('QA-7: reconnect exchanges only the missing ops', () => {
    const sim = three(7, { duplicateRate: 0 });
    sim.type('alice', 0, 'x'.repeat(2000));
    sim.settle();

    sim.disconnect('bob');
    sim.type('bob', 0, 'offline edit'); // 12 ops
    sim.type('alice', 2000, '!'); // 1 op bob misses
    sim.advance(100);

    const before = { ...sim.stats };
    sim.reconnect('bob');
    sim.settle();
    sim.assertConverged();

    const bytes = sim.stats.bytes - before.bytes;
    const fullState = new TextEncoder().encode(JSON.stringify(sim.relay.since({}))).length;
    // hello + relay's 1 missing op + relay hello + bob's 12 ops + forwards of those 12 to alice/carol
    expect(bytes).toBeLessThan(fullState / 20);
  });

  it('recovers from lost messages via periodic anti-entropy', () => {
    const sim = three(8, { dropRate: 0.3, antiEntropyEvery: 25 });
    for (let i = 0; i < 20; i++) {
      sim.type(sim.replicas[i % 3]!, 0, `${i}`);
      sim.advance(10);
    }
    sim.advance(500);
    sim.assertConverged();
    expect(sim.stats.dropped).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const sim = three(99);
      sim.type('alice', 0, 'abc');
      sim.type('bob', 0, 'xyz');
      sim.advance(3);
      sim.type('carol', 0, '123');
      sim.settle();
      return [sim.doc('alice').fullHash(), sim.stats];
    };
    expect(run()).toEqual(run());
  });

  it('rejects unknown replicas and reports divergence', () => {
    const sim = three();
    expect(() => sim.doc('mallory')).toThrow();
    sim.disconnect('bob');
    sim.reconnect('alice'); // already online: no-op
    expect(sim.isOnline('bob')).toBe(false);
    sim.type('alice', 0, 'a');
    sim.settle();
    sim.assertConverged(); // bob is offline, so not compared
    sim.reconnect('bob');
    expect(() => sim.assertConverged()).toThrow(/diverged/);
  });

  it('gives up settling when nothing can get through', () => {
    const sim = three(1, { dropRate: 1 });
    sim.type('alice', 0, 'a');
    expect(() => sim.settle(5)).toThrow(/did not settle/);
  });
});
