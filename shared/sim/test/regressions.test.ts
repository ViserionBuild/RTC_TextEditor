import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute, type Run } from '../src';

/** Replays saved runs (shrunk fuzz failures and hand-written edge cases) forever. */
const dir = new URL('./regressions/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('saved regression runs', () => {
  it.each(files)('%s converges', (file) => {
    const run = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Run & {
      expectText?: string;
    };
    const sim = execute(run);
    if (run.expectText !== undefined) expect(sim.doc(sim.replicas[0]!).text()).toBe(run.expectText);
  });
});
