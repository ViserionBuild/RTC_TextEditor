import fc from 'fast-check';
import { describe, it } from 'vitest';
import { execute, type Action, type Run } from '../src';

/**
 * QA-1..QA-4: random edits on 3 replicas with random outages, latency (reordering),
 * duplication and loss. After everyone reconnects and anti-entropy settles, every replica and
 * the relay must agree. FUZZ_RUNS=10000 for the nightly / `pnpm fuzz` run.
 *
 * On failure the shrunk run is printed as JSON: save it to test/regressions/<name>.json.
 */
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);

const replica = fc.integer({ min: 0, max: 2 });
const pos = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('ins' as const),
      r: replica,
      pos,
      text: fc.string({
        minLength: 1,
        maxLength: 4,
        unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', ' ', '\n'),
      }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('del' as const),
      r: replica,
      pos,
      len: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('off' as const), r: replica }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('on' as const), r: replica }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('wait' as const),
      ticks: fc.integer({ min: 1, max: 40 }),
    }),
  },
);

const run: fc.Arbitrary<Run> = fc.record({
  config: fc.record({
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    replicas: fc.constant(['r0', 'r1', 'r2']),
    minDelay: fc.constant(1),
    maxDelay: fc.integer({ min: 1, max: 60 }),
    duplicateRate: fc.constantFrom(0, 0.2, 0.5),
    dropRate: fc.constantFrom(0, 0, 0.1, 0.3),
    antiEntropyEvery: fc.constantFrom(0, 25, 100),
  }),
  actions: fc.array(action, { maxLength: 150, size: 'max' }),
});

describe('convergence fuzz (shuffled, delayed, duplicated, dropped, partitioned)', () => {
  it(`all replicas converge across ${RUNS} random runs`, () => {
    fc.assert(
      fc.property(run, (r) => {
        try {
          execute(r);
        } catch (err) {
          throw new Error(`${(err as Error).message}\nregression: ${JSON.stringify(r)}`, {
            cause: err,
          });
        }
      }),
      { numRuns: RUNS },
    );
  }, 600_000);
});
