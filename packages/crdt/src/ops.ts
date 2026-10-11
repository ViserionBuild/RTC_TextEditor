import type { OpId, Stamp } from './ids';

/** Insert one UTF-16 code unit immediately after `origin` (null = document start). */
export interface InsertOp {
  readonly type: 'ins';
  readonly id: OpId;
  readonly ts: Stamp;
  readonly origin: OpId | null;
  readonly char: string;
}

/** Mark the element created by `target` as deleted (tombstone). */
export interface DeleteOp {
  readonly type: 'del';
  readonly id: OpId;
  readonly ts: Stamp;
  readonly target: OpId;
}

export type Op = InsertOp | DeleteOp;
