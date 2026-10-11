/** Stable identifier of a replica (one browser tab / device per document). */
export type ReplicaId = string;

/**
 * Identity of an operation. `seq` is contiguous per replica (1, 2, 3, ...), which lets a
 * version vector summarise "everything I have from replica R" as a single number.
 * An inserted element is identified by the id of the insert op that created it.
 */
export interface OpId {
  readonly replica: ReplicaId;
  readonly seq: number;
}

/** Lamport timestamp used to totally order concurrent inserts (RGA tie-break). */
export interface Stamp {
  readonly lamport: number;
  readonly replica: ReplicaId;
}

export const idKey = (id: OpId): string => `${id.seq}@${id.replica}`;

export const idEquals = (a: OpId | null, b: OpId | null): boolean =>
  a === b || (a !== null && b !== null && a.seq === b.seq && a.replica === b.replica);

/** Total order on stamps: higher lamport wins, replica id breaks ties. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}
