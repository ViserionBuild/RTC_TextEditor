/**
 * Server-side validation of untrusted client frames. Kept out of the main entry point so the
 * browser bundle does not ship zod: import from '@collabpad/protocol/validate'.
 */
import { z } from 'zod';
import type { Decoded } from './codec';
import type { ClientMessage, Presence } from './messages';

const replicaId = z.string().min(1).max(64);
const seq = z.number().int().positive();
const opId = z.object({ replica: replicaId, seq });
const stamp = z.object({ lamport: seq, replica: replicaId });

const insertOp = z.object({
  type: z.literal('ins'),
  id: opId,
  ts: stamp,
  origin: opId.nullable(),
  char: z.string().length(1),
});
const deleteOp = z.object({ type: z.literal('del'), id: opId, ts: stamp, target: opId });

export const opSchema = z
  .discriminatedUnion('type', [insertOp, deleteOp])
  .refine((op) => op.id.replica === op.ts.replica, 'op id and stamp must name the same replica');

export const vvSchema = z.record(replicaId, z.number().int().nonnegative());

export const presenceSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  anchor: opId.nullable(),
  head: opId.nullable(),
});

export const clientMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), replica: replicaId, vv: vvSchema }),
  z.object({ kind: z.literal('sync'), vv: vvSchema }),
  z.object({ kind: z.literal('ops'), ops: z.array(opSchema).min(1).max(10_000) }),
  z.object({ kind: z.literal('seen'), vv: vvSchema }),
  z.object({ kind: z.literal('presence'), presence: presenceSchema }),
]);

// Compile-time guarantee that the schemas and the hand-written types never drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemasMatchTypes: [
  Same<z.infer<typeof clientMessageSchema>, ClientMessage>,
  Same<z.infer<typeof presenceSchema>, Presence>,
] = [true, true];
void schemasMatchTypes;

/** Parse and validate an untrusted client frame. */
export function decodeClientMessage(data: string): Decoded<ClientMessage> {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  return { ok: true, msg: parsed.data };
}
