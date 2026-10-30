import { describe, expect, it } from 'vitest';
import { Doc, type Delta } from '../src';
import { authoredOps, rng, shuffle } from './helpers';

/** Replay deltas against a plain string, the way an editor would. */
function applyDeltas(text: string, deltas: readonly Delta[]): string {
  for (const d of deltas) {
    text =
      d.type === 'insert'
        ? text.slice(0, d.index) + d.text + text.slice(d.index)
        : text.slice(0, d.index) + text.slice(d.index + d.length);
  }
  return text;
}

describe('remote deltas', () => {
  it('describe each applied op as a visible-text change', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    const deltas: Delta[] = [];
    b.applyRemote(a.insertAt(0, 'hey'), (d) => deltas.push(d));
    b.applyRemote(a.deleteRange(1, 1), (d) => deltas.push(d));
    expect(deltas).toEqual([
      { type: 'insert', index: 0, text: 'h' },
      { type: 'insert', index: 1, text: 'e' },
      { type: 'insert', index: 2, text: 'y' },
      { type: 'delete', index: 1, length: 1 },
    ]);
  });

  it('emit nothing for a delete of an already-deleted character', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    b.applyRemote(a.insertAt(0, 'x'));
    b.deleteRange(0, 1);
    const deltas: Delta[] = [];
    b.applyRemote(a.deleteRange(0, 1), (d) => deltas.push(d));
    expect(deltas).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'keep a mirrored string identical to the doc under shuffled delivery (seed %i)',
    (seed) => {
      const rand = rng(seed);
      const authors = [new Doc('p'), new Doc('q'), new Doc('r')];
      for (let i = 0; i < 60; i++) {
        const d = authors[i % 3]!;
        if (d.length > 2 && rand() < 0.4) d.deleteRange(Math.floor(rand() * (d.length - 1)), 2);
        else
          d.insertAt(
            Math.floor(rand() * (d.length + 1)),
            'ab'.slice(0, 1 + Math.floor(rand() * 2)),
          );
        if (rand() < 0.3) for (const o of authors) o.applyRemote(d.opsSince(o.versionVector()));
      }

      const local = new Doc('mirror');
      local.insertAt(0, 'local');
      let mirror = local.text();
      const stream = shuffle(authoredOps(authors), rand);
      while (stream.length) {
        const deltas: Delta[] = [];
        local.applyRemote(stream.splice(0, 1 + Math.floor(rand() * 10)), (d) => deltas.push(d));
        mirror = applyDeltas(mirror, deltas);
        expect(mirror).toBe(local.text());
      }
    },
  );
});
