import type { ReplicaId } from './ids';

/** Per-replica summary: highest contiguous seq delivered from each replica. */
export type VersionVector = Record<ReplicaId, number>;

export const vvGet = (vv: VersionVector, replica: ReplicaId): number => vv[replica] ?? 0;

/** Pointwise maximum. */
export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [r, s] of Object.entries(b)) if (s > vvGet(out, r)) out[r] = s;
  return out;
}

/** True when `a` has seen everything `b` has seen (a ≥ b pointwise). */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  return Object.entries(b).every(([r, s]) => vvGet(a, r) >= s);
}

export const vvEquals = (a: VersionVector, b: VersionVector): boolean =>
  vvDominates(a, b) && vvDominates(b, a);

/** Pointwise minimum: what every vector in the set has seen (used for causal stability). */
export function vvMin(vectors: readonly VersionVector[]): VersionVector {
  const [first, ...rest] = vectors;
  if (!first) return {};
  const out: VersionVector = {};
  for (const r of new Set(vectors.flatMap((v) => Object.keys(v)))) {
    const m = Math.min(vvGet(first, r), ...rest.map((v) => vvGet(v, r)));
    if (m > 0) out[r] = m;
  }
  return out;
}
