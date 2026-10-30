import fc from 'fast-check';
import { Doc, type Op } from '@collabpad/crdt';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  chunkOps,
  decodeOps,
  decodeOpsFrame,
  encode,
  encodeOps,
  encodeOpsFrame,
} from '../src';

const opsFromEdits = (edits: { who: number; del: boolean; pos: number; text: string }[]): Op[] => {
  const docs = ['alice', 'bob', 'ünïcode-replica'].map((r) => new Doc(r));
  const out: Op[] = [];
  for (const e of edits) {
    const d = docs[e.who]!;
    if (e.del && d.length > 0) {
      const i = Math.min(d.length - 1, Math.floor(e.pos * d.length));
      out.push(...d.deleteRange(i, Math.min(3, d.length - i)));
    } else {
      out.push(...d.insertAt(Math.floor(e.pos * (d.length + 1)), e.text));
    }
    for (const x of docs) if (x !== d) x.applyRemote(out);
  }
  return out;
};

describe('binary op codec', () => {
  it('round-trips arbitrary op batches, including lone surrogates', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            who: fc.integer({ min: 0, max: 2 }),
            del: fc.boolean(),
            pos: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
            text: fc.string({ minLength: 1, maxLength: 6, unit: 'binary' }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (edits) => {
          const ops = opsFromEdits(edits);
          expect(decodeOps(encodeOps(ops))).toEqual(ops);
        },
      ),
      { numRuns: 300 },
    );
    const lone = new Doc('a').insertAt(0, '\ud800x\udfff');
    expect(decodeOpsFrame(encodeOpsFrame(lone))).toEqual(lone);
  });

  it('compresses typing and backspacing into runs', () => {
    const d = new Doc('replica-1');
    const typed = d.insertAt(0, 'hello world');
    const backspaced = [5, 4, 3].flatMap((i) => d.deleteRange(i, 1)); // right to left
    const ops = [...typed, ...backspaced];
    const binary = encodeOps(ops).length;
    const json = new TextEncoder().encode(encode({ kind: 'ops', ops })).length;
    expect(binary).toBeLessThan(45);
    expect(json / binary).toBeGreaterThan(30);
    expect(decodeOps(encodeOps(ops))).toEqual(ops);
  });

  it.each([
    ['empty', []],
    ['truncated', [1, 1]],
    ['bad replica index', [1, 1, 97, 1, 1, 9, 1, 1, 0, 1, 97]],
    ['zero seq', [1, 1, 97, 1, 1, 0, 0, 1, 0, 1, 97, 0]],
    ['unknown group', [1, 1, 97, 1, 9, 0, 1, 1]],
    ['trailing bytes', [...encodeOps(new Doc('a').insertAt(0, 'x')), 0]],
    ['overlong varint', [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]],
    ['huge run', [1, 1, 97, 1, 1, 0, 1, 1, 0, 0xff, 0xff, 0x7f]],
    ['backspace below seq 1', [1, 1, 97, 1, 3, 0, 1, 1, 0, 1, 2]],
    ['bad utf8 replica', [1, 1, 0xff, 0]],
    ['empty batch', [0, 0]],
  ])('rejects %s', (_, bytes) => {
    expect(() => decodeOps(new Uint8Array(bytes as number[]))).toThrow(DecodeError);
  });

  it('rejects unknown frame tags', () => {
    expect(() => decodeOpsFrame(new Uint8Array([9, 0]))).toThrow(DecodeError);
  });
});

describe('binary decoder robustness', () => {
  it('either decodes or throws DecodeError on random bytes (never anything else)', () => {
    const valid = encodeOps(new Doc('alice').insertAt(0, 'hello'));
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 64 }),
          // Mutations of a valid message reach deeper into the decoder.
          fc.tuple(fc.nat(valid.length - 1), fc.integer({ min: 0, max: 255 })).map(([i, b]) => {
            const copy = valid.slice();
            copy[i] = b;
            return copy;
          }),
        ),
        (bytes) => {
          try {
            const ops = decodeOps(bytes);
            expect(ops.length).toBeGreaterThan(0);
          } catch (err) {
            expect(err).toBeInstanceOf(DecodeError);
          }
        },
      ),
      { numRuns: 5000 },
    );
  });
});

describe('chunkOps', () => {
  it('splits batches into frames the receiver accepts', () => {
    const ops = new Doc('a').insertAt(0, 'x'.repeat(12_001));
    const chunks = chunkOps(ops);
    expect(chunks.map((c) => c.length)).toEqual([5_000, 5_000, 2_001]);
    expect(chunks.flatMap((c) => decodeOps(encodeOps(c)))).toEqual(ops);
    expect(() => decodeOps(encodeOps(ops))).toThrow(DecodeError); // one frame would be rejected
  });
});
