import type { DeleteOp, InsertOp, Op, OpId } from '@collabpad/crdt';

/**
 * Compact binary encoding for op batches.
 *
 *   message := varint(#replicas) replica* varint(#groups) group*
 *   replica := varint(byteLength) utf8
 *   group   := INSERT_RUN r seq lamport origin varint(n) unit*n
 *            | DELETE_RUN(step) r seq lamport tr tseq varint(n)
 *
 * An insert run is n ops by replica r with seqs seq.., stamps lamport.., where each op's origin
 * is the previous op (normal typing). A delete run is n deletes whose target seq moves by +1
 * (forward delete / selection) or -1 (backspace). Replica ids are written once per message and
 * referenced by index; text is stored as UTF-16 code units so any string round-trips.
 */
const INSERT_RUN = 1;
const DELETE_FORWARD = 2;
const DELETE_BACKWARD = 3;

const MAX_OPS = 10_000;
const MAX_REPLICA_BYTES = 64;

class Writer {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(256);
  private len = 0;

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  varint(n: number): void {
    // Unsigned LEB128 for integers up to 2^53.
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

export class DecodeError extends Error {}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new DecodeError('truncated');
    return this.buf[this.pos++]!;
  }

  varint(): number {
    let n = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      n += (b & 0x7f) * scale;
      if (b < 0x80) {
        if (!Number.isSafeInteger(n)) throw new DecodeError('varint too large');
        return n;
      }
      scale *= 0x80;
    }
    throw new DecodeError('varint too long');
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new DecodeError('truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  get done(): boolean {
    return this.pos === this.buf.length;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const continuesInsert = (prev: Op, op: Op): op is InsertOp =>
  prev.type === 'ins' &&
  op.type === 'ins' &&
  op.id.replica === prev.id.replica &&
  op.id.seq === prev.id.seq + 1 &&
  op.ts.lamport === prev.ts.lamport + 1 &&
  op.origin?.replica === prev.id.replica &&
  op.origin.seq === prev.id.seq;

const continuesDelete = (prev: Op, op: Op, step: number): op is DeleteOp =>
  prev.type === 'del' &&
  op.type === 'del' &&
  op.id.replica === prev.id.replica &&
  op.id.seq === prev.id.seq + 1 &&
  op.ts.lamport === prev.ts.lamport + 1 &&
  op.target.replica === prev.target.replica &&
  op.target.seq === prev.target.seq + step;

export function encodeOps(ops: readonly Op[]): Uint8Array<ArrayBuffer> {
  const replicas = new Map<string, number>();
  const ref = (r: string) => {
    let i = replicas.get(r);
    if (i === undefined) replicas.set(r, (i = replicas.size));
    return i;
  };
  for (const op of ops) {
    ref(op.id.replica);
    if (op.type === 'ins' && op.origin) ref(op.origin.replica);
    if (op.type === 'del') ref(op.target.replica);
  }

  const body = new Writer();
  let groups = 0;
  for (let i = 0; i < ops.length;) {
    const first = ops[i]!;
    groups++;
    if (first.type === 'ins') {
      let n = 1;
      while (i + n < ops.length && continuesInsert(ops[i + n - 1]!, ops[i + n]!)) n++;
      body.byte(INSERT_RUN);
      body.varint(ref(first.id.replica));
      body.varint(first.id.seq);
      body.varint(first.ts.lamport);
      if (first.origin) {
        body.byte(1);
        body.varint(ref(first.origin.replica));
        body.varint(first.origin.seq);
      } else {
        body.byte(0);
      }
      body.varint(n);
      for (let k = 0; k < n; k++) body.varint((ops[i + k] as InsertOp).char.charCodeAt(0));
      i += n;
    } else {
      const next = ops[i + 1];
      const step = next && continuesDelete(first, next, -1) ? -1 : 1;
      let n = 1;
      while (i + n < ops.length && continuesDelete(ops[i + n - 1]!, ops[i + n]!, step)) n++;
      body.byte(step === 1 ? DELETE_FORWARD : DELETE_BACKWARD);
      body.varint(ref(first.id.replica));
      body.varint(first.id.seq);
      body.varint(first.ts.lamport);
      body.varint(ref(first.target.replica));
      body.varint(first.target.seq);
      body.varint(n);
      i += n;
    }
  }

  const out = new Writer();
  out.varint(replicas.size);
  for (const r of replicas.keys()) {
    const b = encoder.encode(r);
    out.varint(b.length);
    out.bytes(b);
  }
  out.varint(groups);
  out.bytes(body.finish());
  return out.finish();
}

/** Decode an untrusted batch. Throws DecodeError on anything malformed. */
export function decodeOps(bytes: Uint8Array): Op[] {
  const r = new Reader(bytes);
  const nReplicas = r.varint();
  if (nReplicas > MAX_OPS * 2) throw new DecodeError('too many replicas');
  const replicas: string[] = [];
  for (let i = 0; i < nReplicas; i++) {
    const len = r.varint();
    if (len < 1 || len > MAX_REPLICA_BYTES) throw new DecodeError('bad replica id');
    try {
      replicas.push(decoder.decode(r.bytes(len)));
    } catch {
      throw new DecodeError('bad replica id');
    }
  }
  const replica = () => {
    const name = replicas[r.varint()];
    if (name === undefined) throw new DecodeError('bad replica index');
    return name;
  };
  const positive = () => {
    const n = r.varint();
    if (n < 1) throw new DecodeError('seq and lamport must be positive');
    return n;
  };

  const ops: Op[] = [];
  const groups = r.varint();
  for (let g = 0; g < groups; g++) {
    const tag = r.byte();
    const who = replica();
    const seq = positive();
    const lamport = positive();
    if (tag === INSERT_RUN) {
      const hasOrigin = r.byte();
      if (hasOrigin > 1) throw new DecodeError('bad origin flag');
      let origin: OpId | null = hasOrigin ? { replica: replica(), seq: positive() } : null;
      const n = r.varint();
      if (n < 1 || ops.length + n > MAX_OPS) throw new DecodeError('bad run length');
      for (let k = 0; k < n; k++) {
        const unit = r.varint();
        if (unit > 0xffff) throw new DecodeError('bad character');
        const id = { replica: who, seq: seq + k };
        ops.push({
          type: 'ins',
          id,
          ts: { lamport: lamport + k, replica: who },
          origin,
          char: String.fromCharCode(unit),
        });
        origin = id;
      }
    } else if (tag === DELETE_FORWARD || tag === DELETE_BACKWARD) {
      const step = tag === DELETE_FORWARD ? 1 : -1;
      const target = replica();
      const tseq = positive();
      const n = r.varint();
      if (n < 1 || ops.length + n > MAX_OPS) throw new DecodeError('bad run length');
      if (tseq + step * (n - 1) < 1) throw new DecodeError('bad delete run');
      for (let k = 0; k < n; k++) {
        ops.push({
          type: 'del',
          id: { replica: who, seq: seq + k },
          ts: { lamport: lamport + k, replica: who },
          target: { replica: target, seq: tseq + step * k },
        });
      }
    } else {
      throw new DecodeError(`unknown group ${tag}`);
    }
  }
  if (!r.done) throw new DecodeError('trailing bytes');
  if (ops.length === 0) throw new DecodeError('empty batch');
  return ops;
}

/** Binary WebSocket frames: one tag byte, then the payload. Only op batches are binary. */
export const FrameTag = { Ops: 1 } as const;

export function encodeOpsFrame(ops: readonly Op[]): Uint8Array<ArrayBuffer> {
  const body = encodeOps(ops);
  const frame = new Uint8Array(body.length + 1);
  frame[0] = FrameTag.Ops;
  frame.set(body, 1);
  return frame;
}

export function decodeOpsFrame(frame: Uint8Array): Op[] {
  if (frame[0] !== FrameTag.Ops) throw new DecodeError('unknown frame');
  return decodeOps(frame.subarray(1));
}
