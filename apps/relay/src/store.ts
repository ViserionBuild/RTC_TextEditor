import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Collect, DocState, MemberRecord, Op } from '@collabpad/crdt';

export interface DocMeta {
  id: string;
  title: string;
  createdAt: number;
}

/**
 * Durable storage. The op table is append-only and keyed by (doc, replica, seq), so writing
 * the same op twice is a no-op: the relay is idempotent even across crashes and retries.
 * It stays the complete history even after clients garbage-collect tombstones.
 */
export class Store {
  private readonly db: DatabaseSync;
  private open = true;

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
      CREATE TABLE IF NOT EXISTS snapshots (
        doc_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Columns added after the first release.
    this.addColumn('replica_acks', 'evicted', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('docs', 'collect', 'TEXT');
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

  /** Append ops and update member records in one transaction. */
  appendOps(docId: string, ops: readonly Op[], members: readonly MemberRecord[] = []): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO ops (doc_id, replica, seq, payload) VALUES (?, ?, ?, ?)',
    );
    this.transaction(() => {
      for (const op of ops) insert.run(docId, op.id.replica, op.id.seq, JSON.stringify(op));
      for (const m of members) this.saveMemberUnsafe(docId, m);
    });
  }

  saveMembers(docId: string, members: readonly MemberRecord[]): void {
    this.transaction(() => {
      for (const m of members) this.saveMemberUnsafe(docId, m);
    });
  }

  loadMembers(docId: string): MemberRecord[] {
    const rows = this.db
      .prepare('SELECT replica, vv, last_seen, evicted FROM replica_acks WHERE doc_id = ?')
      .all(docId) as { replica: string; vv: string; last_seen: number; evicted: number }[];
    return rows.map((r) => ({
      replica: r.replica,
      vv: JSON.parse(r.vv) as MemberRecord['vv'],
      lastSeen: r.last_seen,
      evicted: r.evicted === 1,
    }));
  }

  saveCollect(docId: string, collect: Collect): void {
    this.db.prepare('UPDATE docs SET collect = ? WHERE id = ?').run(JSON.stringify(collect), docId);
  }

  loadCollect(docId: string): Collect | null {
    const row = this.db.prepare('SELECT collect FROM docs WHERE id = ?').get(docId) as
      { collect: string | null } | undefined;
    return row?.collect ? (JSON.parse(row.collect) as Collect) : null;
  }

  /** Materialized (garbage-collected) state, so rooms load without replaying the whole log. */
  saveSnapshot(docId: string, state: DocState): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (doc_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (doc_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(docId, JSON.stringify(state), Date.now());
  }

  loadSnapshot(docId: string): DocState | null {
    const row = this.db.prepare('SELECT state FROM snapshots WHERE doc_id = ?').get(docId) as
      { state: string } | undefined;
    return row ? (JSON.parse(row.state) as DocState) : null;
  }

  get isOpen(): boolean {
    return this.open;
  }

  close(): void {
    this.open = false;
    this.db.close();
  }

  private saveMemberUnsafe(docId: string, m: MemberRecord): void {
    this.db
      .prepare(
        `INSERT INTO replica_acks (doc_id, replica, vv, last_seen, evicted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (doc_id, replica) DO UPDATE SET
           vv = excluded.vv, last_seen = excluded.last_seen, evicted = excluded.evicted`,
      )
      .run(docId, m.replica, JSON.stringify(m.vv), m.lastSeen, m.evicted ? 1 : 0);
  }

  private addColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
