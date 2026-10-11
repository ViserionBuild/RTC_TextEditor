import { Doc, type Op } from '../src';

/** Deterministic PRNG (mulberry32) so failures are reproducible from the seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Full bidirectional anti-entropy between every pair of docs. */
export function syncAll(docs: readonly Doc[]): void {
  for (const a of docs)
    for (const b of docs) if (a !== b) b.applyRemote(a.opsSince(b.versionVector()));
}

/** Every op authored by each doc (each op appears once). */
export function authoredOps(docs: readonly Doc[]): Op[] {
  return docs.flatMap((d) => d.opsSince({}).filter((op) => op.id.replica === d.replica));
}
