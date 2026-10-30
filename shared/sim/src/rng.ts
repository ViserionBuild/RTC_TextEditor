/** Seeded PRNG (mulberry32). Every simulation is reproducible from its seed. */
export type Rand = () => number;

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max]. */
export const randInt = (rand: Rand, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));
