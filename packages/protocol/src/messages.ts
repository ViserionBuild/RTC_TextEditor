import { z } from 'zod';
import type { Op, VersionVector } from '@collabpad/crdt';

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
  /** Cursor and selection head as CRDT anchors (null = document start). */
  anchor: opId.nullable(),
  head: opId.nullable(),
});

/** Client → relay. */
export const clientMessageSchema = z.discriminatedUnion('kind', [
  /** First message on a connection: who I am and what I already have. */
  z.object({ kind: z.literal('hello'), replica: replicaId, vv: vvSchema }),
  /** Anti-entropy: "this is what I have". Relay answers with missing ops + its own vector. */
  z.object({ kind: z.literal('sync'), vv: vvSchema }),
  /** New ops authored by this replica. */
  z.object({ kind: z.literal('ops'), ops: z.array(opSchema).min(1).max(10_000) }),
  z.object({ kind: z.literal('presence'), presence: presenceSchema }),
]);

export type Presence = z.infer<typeof presenceSchema>;

/** Relay → client. */
export type ServerMessage =
  /** Ops the client is missing (catch-up or live broadcast). */
  | { kind: 'ops'; ops: Op[] }
  /** Relay's version vector, sent after a hello/sync. Client replies with ops the relay lacks. */
  | { kind: 'sync'; vv: VersionVector }
  /** Everything up to `vv` is durably stored. */
  | { kind: 'ack'; vv: VersionVector }
  /** Pointwise minimum of every member replica's vector: ops at or below it are causally stable. */
  | { kind: 'stable'; vv: VersionVector }
  | { kind: 'presence'; replica: string; presence: Presence }
  | { kind: 'presence-left'; replica: string }
  | { kind: 'error'; code: ErrorCode; message: string };

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ErrorCode = 'bad-message' | 'not-hello' | 'forged-op' | 'rate-limited';

/** WebSocket close codes used by the relay (4000–4999 are application-defined). */
export const CloseCode = {
  PolicyViolation: 1008,
  TooLarge: 1009,
  UnknownDoc: 4404,
  Replaced: 4409,
  RateLimited: 4429,
} as const;
