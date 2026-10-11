import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, vvGet, vvMin, type Collect, type Op, type VersionVector } from '../src';

/**
 * GC safety without a network: an adversarial scheduler that gives exactly the guarantees
 * the relay's StabilityTracker gives, and nothing more.
 *
 *  - "frontier": S = what every author has seen; C[R] = R's own seq now (R has seen S).
 *  - "collect":  a replica that has every op ≤ C may collect within S, even while ops > C are
 *                still undelivered; those then arrive in any order.
 *
 * Collected replicas must end up identical (visible text and ids) to one that never collects.
 */
const N_AUTHORS = 3;
const RUNS = Number(process.env.GC_PROPERTY_RUNS ?? 500);

type Step =
  | { t: 'ins'; who: number; pos: number; ch: string }
  | { t: 'del'; who: number; pos: number }
  | { t: 'deliver'; to: number; frac: number; seed: number }
  | { t: 'frontier' }
  | { t: 'collect'; who: number };

const who = fc.integer({ min: 0, max: N_AUTHORS }); // index N_AUTHORS = passive observer
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('ins' as const),
      who: fc.integer({ min: 0, max: N_AUTHORS - 1 }),
      pos: fc.double({ min: 0, max: 1, noNaN: true }),
      ch: fc.constantFrom('a', 'b', 'c'),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('del' as const),
      who: fc.integer({ min: 0, max: N_AUTHORS - 1 }),
      pos: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('deliver' as const),
      to: who,
      frac: fc.double({ min: 0, max: 1, noNaN: true }),
      seed: fc.nat(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('frontier' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('collect' as const), who }) },
);

function run(steps: readonly Step[]) {
  const authors = Array.from({ length: N_AUTHORS }, (_, i) => new Doc(`r${i}`));
  const replicas = [...authors, new Doc('observer')];
  const reference = new Doc('reference'); // never collects
  const all: Op[] = [];
  let collect: Collect | null = null;
  let collected = 0;

  const has = (d: Doc, op: Op) => op.id.seq <= vvGet(d.versionVector(), op.id.replica);
  for (const s of steps) {
    if (s.t === 'ins' || s.t === 'del') {
      const d = authors[s.who]!;
      if (s.t === 'ins') all.push(...d.insertAt(Math.floor(s.pos * d.length), s.ch));
      else if (d.length > 0)
        all.push(...d.deleteRange(Math.min(d.length - 1, Math.floor(s.pos * d.length)), 1));
    } else if (s.t === 'deliver') {
      const d = replicas[s.to]!;
      let x = s.seed;
      d.applyRemote(
        all.filter(
          (op) => !has(d, op) && (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 < s.frac,
        ),
      );
    } else if (s.t === 'frontier') {
      const S: VersionVector = vvMin(authors.map((a) => a.versionVector()));
      const C: VersionVector = Object.fromEntries(
        authors.map((a) => [a.replica, vvGet(a.versionVector(), a.replica)]),
      );
      collect = { vv: S, requires: C };
    } else if (collect) {
      const d = replicas[s.who]!;
      const { requires } = collect;
      d.applyRemote(all.filter((op) => op.id.seq <= vvGet(requires, op.id.replica)));
      collected += d.collect(collect);
    }
  }
  for (const d of [...replicas, reference]) d.applyRemote(all);
  return { replicas, reference, collected };
}

/**
 * The schedule the RGA neighbour rule exists for (see "keeps a tombstone whose right neighbour
 * is newer" in gc.test.ts). Random search almost never assembles it, so it is always run.
 */
const deliverAll = (to: number): Step => ({ t: 'deliver', to, frac: 1, seed: 1 });
const neighbourTrap: Step[] = [
  { t: 'ins', who: 0, pos: 0, ch: 'a' }, // r0: O
  deliverAll(1),
  deliverAll(2),
  { t: 'ins', who: 1, pos: 1, ch: 'b' }, // r1: e, right after O
  deliverAll(0),
  deliverAll(2),
  { t: 'del', who: 2, pos: 0.5 }, // r2 deletes e
  deliverAll(0),
  // r1 has not seen the delete: it ages its clock, then types Y right after e.
  ...Array.from({ length: 20 }, (): Step[] => [
    { t: 'ins', who: 1, pos: 1, ch: 'c' },
    { t: 'del', who: 1, pos: 0.99 },
  ]).flat(),
  { t: 'ins', who: 1, pos: 1, ch: 'c' },
  deliverAll(1),
  { t: 'frontier' }, // S = {O, e, delete}; Y is only in C
  { t: 'ins', who: 0, pos: 1, ch: 'a' }, // r0 (not having seen Y) types N after O
  { t: 'collect', who: 3 }, // observer collects before N arrives
];

describe('GC safety under adversarial delivery (QA-8)', () => {
  it(`collected replicas match a never-collected one (${RUNS} runs)`, () => {
    let collected = 0;
    fc.assert(
      fc.property(fc.array(step, { minLength: 10, maxLength: 150, size: 'max' }), (steps) => {
        const r = run(steps);
        collected += r.collected;
        for (const d of r.replicas) {
          expect(d.pendingCount).toBe(0);
          expect(d.text()).toBe(r.reference.text());
          expect(d.liveHash()).toBe(r.reference.liveHash());
        }
      }),
      { numRuns: RUNS, examples: [[neighbourTrap]] },
    );
    expect(collected).toBeGreaterThan(0);
  }, 600_000);
});
