import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocSnapshot, ReplicaId } from '@collabpad/crdt';

/**
 * Offline persistence. Each browser tab editing a document is its own replica; its CRDT
 * snapshot (including ops the relay has not acknowledged yet) lives in IndexedDB.
 *
 * A reload must reuse the same replica id, or unsent ops would be orphaned, but two open tabs
 * must never share one. A Web Lock per replica gives exactly that: a tab reuses a stored replica
 * it can lock, and a second tab gets a fresh one.
 *
 * On reload the old page may still hold its lock for a moment, so the tab remembers its replica
 * in sessionStorage (which survives reloads of the same tab) and waits briefly for that lock.
 */
interface Schema extends DBSchema {
  replicas: {
    key: string;
    value: {
      key: string;
      docId: string;
      replica: ReplicaId;
      snapshot: DocSnapshot;
      updatedAt: number;
    };
    indexes: { byDoc: string };
  };
}

export interface ClaimedReplica {
  replica: ReplicaId;
  snapshot: DocSnapshot | null;
  save(snapshot: DocSnapshot): Promise<void>;
  release(): void;
  /** Delete this replica's stored state and release it (after rejoining under a new id). */
  forget(): Promise<void>;
}

let dbPromise: Promise<IDBPDatabase<Schema>> | undefined;
const db = () =>
  (dbPromise ??= openDB<Schema>('collabpad', 1, {
    upgrade(d) {
      d.createObjectStore('replicas', { keyPath: 'key' }).createIndex('byDoc', 'docId');
    },
  }));

export function newReplicaId(): ReplicaId {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return (
    Array.from(bytes, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-2)
  );
}

const RELOAD_LOCK_WAIT_MS = 3000;

/**
 * Resolve with a release function once the lock is held, or null if it is not free right now
 * (or within `waitMs`).
 */
function tryLock(name: string, waitMs = 0): Promise<(() => void) | null> {
  if (!navigator.locks) return Promise.resolve(() => {});
  const options: LockOptions =
    waitMs > 0 ? { signal: AbortSignal.timeout(waitMs) } : { ifAvailable: true };
  return new Promise((resolve) => {
    navigator.locks
      .request(name, options, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(null)); // aborted by the timeout
  });
}

const tabKey = (docId: string) => `collabpad:replica:${docId}`;

function tabReplica(docId: string): ReplicaId | null {
  try {
    return sessionStorage.getItem(tabKey(docId));
  } catch {
    return null;
  }
}

function rememberTabReplica(docId: string, replica: ReplicaId): void {
  try {
    sessionStorage.setItem(tabKey(docId), replica);
  } catch {
    // ignore
  }
}

/** `fresh`: skip stored replicas and start a new one (rejoining after eviction). */
export async function claimReplica(docId: string, { fresh = false } = {}): Promise<ClaimedReplica> {
  const store = await db();
  const records = (await store.getAllFromIndex('replicas', 'byDoc', docId)).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  let replica: ReplicaId | null = null;
  let snapshot: DocSnapshot | null = null;
  let release: () => void = () => {};

  const lockName = (r: ReplicaId) => `collabpad:${docId}:${r}`;
  const previous = fresh ? null : tabReplica(docId);

  if (fresh) {
    // fall through to a new replica
  } else if (navigator.locks) {
    // This tab's own replica first, waiting out a reload. It may have no IndexedDB record yet
    // (its first save was still debounced) but still have ops in the teardown journal.
    if (previous) {
      const r = await tryLock(lockName(previous), RELOAD_LOCK_WAIT_MS);
      if (r) {
        replica = previous;
        snapshot = records.find((rec) => rec.replica === previous)?.snapshot ?? null;
        release = r;
      }
    }
    // Otherwise any stored replica no other tab is using.
    for (const rec of records) {
      if (replica) break;
      if (rec.replica === previous) continue;
      const r = await tryLock(lockName(rec.replica));
      if (r) {
        ({ replica, snapshot } = rec);
        release = r;
      }
    }
  } else {
    // No Web Locks (insecure context): one replica per tab session.
    replica = previous;
    snapshot = records.find((r) => r.replica === replica)?.snapshot ?? null;
  }

  if (!replica) {
    replica = newReplicaId();
    release = (await tryLock(lockName(replica))) ?? (() => {});
  }
  rememberTabReplica(docId, replica);

  const id = replica;
  return {
    replica: id,
    snapshot,
    save: async (snap) => {
      await store.put('replicas', {
        key: `${docId}/${id}`,
        docId,
        replica: id,
        snapshot: snap,
        updatedAt: Date.now(),
      });
    },
    release,
    forget: async () => {
      await store.delete('replicas', `${docId}/${id}`);
      release();
    },
  };
}
