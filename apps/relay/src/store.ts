import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Op, ReplicaId, VersionVector } from '@collabpad/crdt';

export interface DocMeta {
  id: string;
  title: string;
  createdAt: number;
}

export interface ReplicaAck {
  replica: ReplicaId;
  vv: VersionVector;
  lastSeen: number;
}

/**
 * Durable storage. The op table is append-only and keyed by (doc, replica, seq), so writing
 * the same op twice is a no-op: the relay is idempotent even across crashes and retries.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:')
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        doc_id TEXT NOT NULL,
        replica TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (doc_id, replica, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS replica_acks (
        doc_id TEXT NOT NULL,
        replica TEXT NOT NULL,
        vv TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (doc_id, replica)
      ) WITHOUT ROWID;
    `);
  }

  createDoc(title = 'Untitled'): DocMeta {
    const meta = { id: randomBytes(16).toString('base64url'), title, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO docs (id, title, created_at) VALUES (?, ?, ?)')
      .run(meta.id, meta.title, meta.createdAt);
    return meta;
  }

  getDoc(id: string): DocMeta | undefined {
    const row = this.db.prepare('SELECT id, title, created_at FROM docs WHERE id = ?').get(id) as
      { id: string; title: string; created_at: number } | undefined;
    return row && { id: row.id, title: row.title, createdAt: row.created_at };
  }

  renameDoc(id: string, title: string): boolean {
    return this.db.prepare('UPDATE docs SET title = ? WHERE id = ?').run(title, id).changes > 0;
  }

  /** All ops of a doc, per replica in seq order. */
  loadOps(docId: string): Op[] {
    const rows = this.db
      .prepare('SELECT payload FROM ops WHERE doc_id = ? ORDER BY replica, seq')
      .all(docId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Op);
  }

  /** Append ops and update the sender's ack in one transaction. */
  appendOps(docId: string, ops: readonly Op[], ack?: ReplicaAck): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO ops (doc_id, replica, seq, payload) VALUES (?, ?, ?, ?)',
    );
    this.transaction(() => {
      for (const op of ops) insert.run(docId, op.id.replica, op.id.seq, JSON.stringify(op));
      if (ack) this.saveAckUnsafe(docId, ack);
    });
  }

  saveAck(docId: string, ack: ReplicaAck): void {
    this.saveAckUnsafe(docId, ack);
  }

  loadAcks(docId: string): ReplicaAck[] {
    const rows = this.db
      .prepare('SELECT replica, vv, last_seen FROM replica_acks WHERE doc_id = ?')
      .all(docId) as { replica: string; vv: string; last_seen: number }[];
    return rows.map((r) => ({
      replica: r.replica,
      vv: JSON.parse(r.vv) as VersionVector,
      lastSeen: r.last_seen,
    }));
  }

  close(): void {
    this.db.close();
  }

  private saveAckUnsafe(docId: string, ack: ReplicaAck): void {
    this.db
      .prepare(
        `INSERT INTO replica_acks (doc_id, replica, vv, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT (doc_id, replica) DO UPDATE SET vv = excluded.vv, last_seen = excluded.last_seen`,
      )
      .run(docId, ack.replica, JSON.stringify(ack.vv), ack.lastSeen);
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
