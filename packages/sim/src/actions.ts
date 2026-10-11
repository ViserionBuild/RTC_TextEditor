import type { ReplicaId } from '@collabpad/crdt';
import { Simulation, type SimConfig } from './simulation';

/**
 * A serialisable fuzz step. Positions are fractions of the current document length, so any
 * sequence of actions is valid regardless of what happened before (keeps shrinking simple).
 */
export type Action =
  | { t: 'ins'; r: number; pos: number; text: string }
  | { t: 'del'; r: number; pos: number; len: number }
  | { t: 'off'; r: number }
  | { t: 'on'; r: number }
  | { t: 'wait'; ticks: number };

export interface Run {
  readonly config: SimConfig;
  readonly actions: readonly Action[];
}

/** Replay a run, bring every replica back online, settle and assert convergence. */
export function execute({ config, actions }: Run): Simulation {
  const sim = new Simulation(config);
  const pick = (i: number): ReplicaId => sim.replicas[i % sim.replicas.length]!;
  for (const a of actions) {
    switch (a.t) {
      case 'ins': {
        const r = pick(a.r);
        sim.type(r, Math.floor(a.pos * (sim.doc(r).length + 1)), a.text);
        break;
      }
      case 'del': {
        const r = pick(a.r);
        const len = sim.doc(r).length;
        if (len === 0) break;
        const index = Math.min(Math.floor(a.pos * len), len - 1);
        sim.delete(r, index, Math.min(a.len, len - index));
        break;
      }
      case 'off':
        sim.disconnect(pick(a.r));
        break;
      case 'on':
        sim.reconnect(pick(a.r));
        break;
      case 'wait':
        sim.advance(a.ticks);
        break;
    }
  }
  for (const r of sim.replicas) sim.reconnect(r);
  sim.settle();
  sim.assertConverged();
  return sim;
}
