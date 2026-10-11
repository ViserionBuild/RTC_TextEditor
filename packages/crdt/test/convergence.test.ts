import { describe, expect, it } from 'vitest';
import { Doc, type Op } from '../src';
import { authoredOps, rng, shuffle, syncAll } from './helpers';

const expectConverged = (docs: Doc[]): void => {
  const [first, ...rest] = docs;
  for (const d of rest) {
    expect(d.text()).toBe(first!.text());
    expect(d.stateHash()).toBe(first!.stateHash());
    expect(d.fullHash()).toBe(first!.fullHash());
    expect(d.versionVector()).toEqual(first!.versionVector());
    expect(d.pendingCount).toBe(0);
  }
};

describe('QA-5: concurrent insertion at the same position', () => {
  it('keeps both runs intact and orders them identically everywhere', () => {
    const [a, b, c] = [new Doc('alice'), new Doc('bob'), new Doc('carol')];
    a.insertAt(0, 'Hello!');
    syncAll([a, b, c]);

    // All three are offline and type at index 5 at the same time.
    a.insertAt(5, ' Alice');
    b.insertAt(5, ' Bob');
    c.insertAt(5, ' Carol');
    syncAll([a, b, c]);

    expectConverged([a, b, c]);
    const text = a.text();
    for (const word of [' Alice', ' Bob', ' Carol']) expect(text).toContain(word);
    expect(text.startsWith('Hello')).toBe(true);
    expect(text.endsWith('!')).toBe(true);
  });
});

describe('QA-6: concurrent insertion and deletion at the same position', () => {
  it('preserves an insert whose left neighbour was concurrently deleted', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'cat');
    syncAll([a, b]);

    a.deleteRange(1, 1); // "ct"   – deletes "a"
    b.insertAt(2, 'r'); //  "cart" – inserts right after "a"
    syncAll([a, b]);

    expectConverged([a, b]);
    expect(a.text()).toBe('crt');
  });

  it('handles both replicas deleting the same character', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'abc');
    syncAll([a, b]);
    a.deleteRange(1, 1);
    b.deleteRange(1, 1);
    b.insertAt(1, 'X');
    syncAll([a, b]);
    expectConverged([a, b]);
    expect(a.text()).toBe('aXc');
  });
});

describe('delivery order independence', () => {
  /** Three replicas make concurrent edits; return their ops and the reference result. */
  function scenario(seed: number) {
    const rand = rng(seed);
    const docs = [new Doc('r1'), new Doc('r2'), new Doc('r3')];
    for (let round = 0; round < 6; round++) {
      for (const d of docs) {
        for (let k = 0; k < 4; k++) {
          if (d.length > 0 && rand() < 0.35) {
            const i = Math.floor(rand() * d.length);
            d.deleteRange(i, Math.min(1 + Math.floor(rand() * 3), d.length - i));
          } else {
            d.insertAt(
              Math.floor(rand() * (d.length + 1)),
              String.fromCharCode(97 + Math.floor(rand() * 26)).repeat(1 + Math.floor(rand() * 3)),
            );
          }
        }
      }
      if (rand() < 0.5) syncAll(docs); // sometimes partitions last several rounds
    }
    const ops = authoredOps(docs);
    syncAll(docs);
    return { ops, expected: docs[0]! };
  }

  it.each(Array.from({ length: 200 }, (_, i) => i + 1))(
    'converges for seed %i (shuffled + duplicated + batched)',
    (seed) => {
      const { ops, expected } = scenario(seed);
      const rand = rng(seed * 7919);

      const replicas = ['x', 'y', 'z'].map((id) => new Doc(id));
      for (const doc of replicas) {
        // Duplicate ~30% of ops, shuffle everything, deliver in random-sized batches.
        const stream: Op[] = shuffle(
          ops.flatMap((op) => (rand() < 0.3 ? [op, op] : [op])),
          rand,
        );
        while (stream.length) doc.applyRemote(stream.splice(0, 1 + Math.floor(rand() * 8)));
      }

      expectConverged([expected, ...replicas]);
    },
  );

  it('re-delivering everything is a no-op (idempotency)', () => {
    const { ops, expected } = scenario(42);
    const before = expected.fullHash();
    expect(expected.applyRemote(ops)).toEqual([]);
    expect(expected.fullHash()).toBe(before);
  });
});

describe('anti-entropy with version vectors', () => {
  it('sends only the missing ops after an offline period', () => {
    const [a, b] = [new Doc('a'), new Doc('b')];
    a.insertAt(0, 'shared base text');
    syncAll([a, b]);

    b.insertAt(0, 'offline: '); // b is offline for 9 ops
    const missing = b.opsSince(a.versionVector());
    expect(missing).toHaveLength(9);
    expect(missing.every((op) => op.id.replica === 'b')).toBe(true);
    expect(a.opsSince(b.versionVector())).toHaveLength(0);

    a.applyRemote(missing);
    expectConverged([a, b]);
  });
});
