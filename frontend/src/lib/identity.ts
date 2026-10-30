import type { Identity } from '../collab/plugin';

const KEY = 'collabpad:identity';
const ADJECTIVES = [
  'Swift',
  'Quiet',
  'Brave',
  'Clever',
  'Sunny',
  'Lucky',
  'Calm',
  'Bold',
  'Witty',
  'Keen',
];
const ANIMALS = [
  'Otter',
  'Falcon',
  'Panda',
  'Lynx',
  'Heron',
  'Fox',
  'Koala',
  'Orca',
  'Ibex',
  'Wren',
];
// Eight clearly distinct hues, all dark enough for white label text.
export const COLORS = [
  '#d9480f',
  '#c92a2a',
  '#c2255c',
  '#6741d9',
  '#1971c2',
  '#0c8599',
  '#2f9e44',
  '#8d5a3b',
];

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export function loadIdentity(): Identity {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Identity | null;
    if (saved?.name && /^#[0-9a-f]{6}$/i.test(saved.color)) return saved;
  } catch {
    // fall through to a fresh identity
  }
  const fresh = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
  saveIdentity(fresh);
  return fresh;
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // storage unavailable: identity just won't persist
  }
}
