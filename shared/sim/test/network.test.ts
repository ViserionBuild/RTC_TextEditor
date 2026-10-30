import { describe, expect, it } from 'vitest';
import { Network, mulberry32 } from '../src';

const opts = { minDelay: 1, maxDelay: 10, duplicateRate: 0, dropRate: 0 };

describe('Network', () => {
  it('delivers in timestamp order and reorders messages with independent delays', () => {
    const net = new Network<number>(mulberry32(1), opts);
    for (let i = 0; i < 50; i++) net.send('a', 'b', i);
    const got: number[] = [];
    let env;
    while ((env = net.deliverNext()) !== undefined) if (env) got.push(env.msg);
    expect([...got].sort((x, y) => x - y)).toEqual([...Array(50).keys()]);
    expect(got).not.toEqual([...Array(50).keys()]);
    expect(net.stats).toMatchObject({ sent: 50, delivered: 50, dropped: 0 });
  });

  it('duplicates and drops at the configured rates', () => {
    const net = new Network<number>(mulberry32(2), { ...opts, duplicateRate: 0.5, dropRate: 0.2 });
    for (let i = 0; i < 1000; i++) net.send('a', 'b', i);
    expect(net.stats.dropped).toBeGreaterThan(150);
    expect(net.stats.dropped).toBeLessThan(250);
    expect(net.stats.duplicated).toBeGreaterThan(500);
    expect(net.inFlight).toBe(1000 - net.stats.dropped + net.stats.duplicated);
  });

  it('drops traffic to and from offline nodes, including messages already in flight', () => {
    const net = new Network<string>(mulberry32(3), opts);
    net.send('a', 'b', 'in flight');
    net.setOnline('b', false);
    net.send('a', 'b', 'never sent');
    expect(net.stats.sent).toBe(1);
    expect(net.deliverNext()).toBeNull();
    expect(net.deliverNext()).toBeUndefined();
    expect(net.isOnline('b')).toBe(false);
  });
});
