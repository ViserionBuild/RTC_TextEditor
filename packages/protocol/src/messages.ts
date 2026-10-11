import type { Collect, DocState, Op, OpId, ReplicaId, VersionVector } from '@collabpad/crdt';

/** Ephemeral cursor state. Positions are CRDT anchors so they survive concurrent edits. */
export interface Presence {
  name: string;
  /** #rrggbb */
  color: string;
  anchor: OpId | null;
  head: OpId | null;
}

/** Client → relay. */
export type ClientMessage =
  /** First message on a connection: who I am and what I already have. */
  | { kind: 'hello'; replica: ReplicaId; vv: VersionVector }
  /** Anti-entropy: "this is what I have". Relay answers with missing ops + its own vector. */
  | { kind: 'sync'; vv: VersionVector }
  /** New ops authored by this replica. */
  | { kind: 'ops'; ops: Op[] }
  /** "I have integrated this": an acknowledgement for stability, with no reply. */
  | { kind: 'seen'; vv: VersionVector }
  | { kind: 'presence'; presence: Presence };

/** Relay → client. */
export type ServerMessage =
  /** Ops the client is missing (catch-up or live broadcast). */
  | { kind: 'ops'; ops: Op[] }
  /** Bootstrap state for a client that has nothing yet (sent before any catch-up ops). */
  | { kind: 'snapshot'; state: DocState }
  /** Permission to garbage-collect tombstones (see StabilityTracker). */
  | { kind: 'collect'; collect: Collect }
  /** Relay's version vector, sent after a hello/sync. Client replies with ops the relay lacks. */
  | { kind: 'sync'; vv: VersionVector }
  /** Everything up to `vv` is durably stored. */
  | { kind: 'ack'; vv: VersionVector }
  /** Pointwise minimum of every member replica's vector: ops at or below it are causally stable. */
  | { kind: 'stable'; vv: VersionVector }
  | { kind: 'presence'; replica: ReplicaId; presence: Presence }
  | { kind: 'presence-left'; replica: ReplicaId }
  | { kind: 'error'; code: ErrorCode; message: string };

export type ErrorCode = 'bad-message' | 'not-hello' | 'forged-op' | 'rate-limited';

/** WebSocket close codes used by the relay (4000–4999 are application-defined). */
export const CloseCode = {
  PolicyViolation: 1008,
  TooLarge: 1009,
  UnknownDoc: 4404,
  Replaced: 4409,
  /** Evicted, or offline edits that predate GC: reconnect under a new replica id. */
  Rejoin: 4410,
  RateLimited: 4429,
} as const;
