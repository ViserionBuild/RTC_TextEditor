import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, Rga, type Op } from '../src';
import { NaiveRga } from './reference/naive-rga';

/**
 * The run-length RGA must place every character exactly where the per-character reference
 * does, tombstones included, for any causally valid delivery order.
 */
function feed(ops: readonly Op[]) {
  const fast = new Rga();
  const naive = new NaiveRga();
  // A Doc does the causal buffering; its RGA is the run-length one. Mirror into the naive one.
  const doc = new Doc('observer');
  for (const op of doc.applyRemote(ops)) {
    if (op.type === 'ins') {
      fast.integrateInsert(op);
      naive.integrateInsert(op);
    } else {
      fast.integrateDelete(op);
      naive.integrateDelete(op);
    }
  }
  return { fast, naive, doc };
}

const shape = (r: Rga | NaiveRga) =>
  r.elements().map((e) => `${e.id.seq}@${e.id.replica}${e.deleted ? '-' : '+'}${e.char}`);

describe('run-length RGA vs per-character reference', () => {
  it('agrees element-for-element on random concurrent editing', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            who: fc.integer({ min: 0, max: 2 }),
            del: fc.boolean(),
            pos: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
            len: fc.integer({ min: 1, max: 6 }),
            sync: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 1, maxLength: 120, size: 'max' },
        ),
        fc.integer(),
        (steps, seed) => {
          const docs = ['a', 'b', 'c'].map((r) => new Doc(r));
          for (const s of steps) {
            const d = docs[s.who]!;
            if (s.del && d.length > 0) {
              const i = Math.min(d.length - 1, Math.floor(s.pos * d.length));
              d.deleteRange(i, Math.min(s.len, d.length - i));
            } else {
              d.insertAt(Math.floor(s.pos * (d.length + 1)), 'xyzw'.repeat(2).slice(0, s.len));
            }
            if (s.sync === 0)
              for (const x of docs)
                for (const y of docs) y.applyRemote(x.opsSince(y.versionVector()));
          }
          const ops = docs.flatMap((d) =>
            d.opsSince({}).filter((op) => op.id.replica === d.replica),
          );
          // Shuffle deterministically; the Doc buffers anything not yet causally ready.
          let x = seed >>> 0;
          const shuffled = [...ops].sort(() =>
            (x = (x * 1664525 + 1013904223) >>> 0) & 1 ? 1 : -1,
          );
          const { fast, naive, doc } = feed(shuffled);
          expect(shape(fast)).toEqual(shape(naive));
          expect(fast.text()).toBe(naive.text());
          expect(doc.text()).toBe(fast.text());
          expect(fast.size).toBe(naive.size);
        },
      ),
      { numRuns: Number(process.env.DIFF_RUNS ?? 300) },
    );
  });

  it('stores typed text as few runs', () => {
    const d = new Doc('a');
    d.insertAt(0, 'hello world, this is one run');
    expect(d.stats().items).toBe(1);
    d.insertAt(5, ' there'); // splits the run once and adds one
    expect(d.stats().items).toBe(3);
    d.deleteRange(0, 5); // deleting a whole run: still one (tombstone) run
    expect(d.stats()).toMatchObject({ items: 3, tombstones: 5 });
    d.deleteRange(0, 3); // backspacing through the next run merges tombstones
    expect(d.stats().items).toBe(4);
  });
});
