import { SyncClient } from '@collabpad/client';
import { Doc, type VersionVector } from '@collabpad/crdt';
import { wsUrl } from '../lib/api';
import { clearJournal, readJournal, writeJournal } from './journal';
import { claimReplica, type ClaimedReplica } from './storage';

const SAVE_DEBOUNCE_MS = 500;

/**
 * Sessions for the same doc run one after another, so a remount (React StrictMode, fast
 * navigation) reclaims the same replica lock instead of racing for it.
 */
const lastClosed = new Map<string, Promise<void>>();

export interface Session {
  /** The current client. It changes if the relay makes this tab rejoin under a new replica. */
  readonly client: SyncClient;
  onReplace(fn: (client: SyncClient) => void): () => void;
  close(): Promise<void>;
}

/** Keeps one replica's state saved: debounced IndexedDB snapshots plus a teardown journal. */
function persist(docId: string, client: SyncClient, claim: ClaimedReplica, restored: boolean) {
  const { doc } = client;
  /** Vector covered by the last completed IndexedDB save (for the teardown journal). */
  let savedVV: VersionVector = restored ? doc.versionVector() : {};
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    const vv = doc.versionVector();
    await claim.save(doc.snapshot());
    savedVV = vv;
    clearJournal(docId, claim.replica);
  };
  const scheduleSave = () => {
    dirty = true;
    timer ??= setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  };
  // Teardown: journal synchronously (always completes), then attempt the async save as well.
  const onPageHide = () => {
    writeJournal(docId, claim.replica, doc.opsSince(savedVV));
    void flush();
  };
  const onHide = () => document.visibilityState === 'hidden' && onPageHide();

  const off = [
    client.on('local', scheduleSave),
    client.on('remote', scheduleSave),
    client.on('collected', scheduleSave),
  ];
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  return {
    scheduleSave,
    async stop() {
      off.forEach((fn) => fn());
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      await flush();
    },
  };
}

/**
 * Open a document: restore this tab's replica from IndexedDB (offline edits included),
 * connect to the relay, and keep the snapshot saved as edits happen.
 */
export async function openSession(docId: string): Promise<Session> {
  const previous = lastClosed.get(docId);
  let markClosed!: () => void;
  lastClosed.set(docId, new Promise((resolve) => (markClosed = resolve)));
  await previous;

  let claim = await claimReplica(docId);
  const doc = claim.snapshot ? Doc.load(claim.replica, claim.snapshot) : new Doc(claim.replica);
  const journal = readJournal(docId, claim.replica);
  doc.applyRemote(journal);

  let client = new SyncClient({ url: wsUrl(), docId, doc });
  let saver = persist(docId, client, claim, claim.snapshot !== null);
  if (journal.length) saver.scheduleSave(); // get the replayed ops into IndexedDB

  const listeners = new Set<(client: SyncClient) => void>();
  let closed = false;

  // Evicted (or offline edits that predate GC): continue as a new replica, replaying our
  // unacknowledged edits, then drop the old replica's stored state.
  const watchRejoin = (c: SyncClient) =>
    c.on('rejoin', () => {
      void (async () => {
        const next = await claimReplica(docId, { fresh: true });
        const replacement = await c.rejoinAs(next.replica);
        if (closed) return void replacement.disconnect();
        await saver.stop();
        await claim.forget();
        claim = next;
        client = replacement;
        saver = persist(docId, client, claim, false);
        saver.scheduleSave();
        watchRejoin(client);
        for (const fn of listeners) fn(client);
      })();
    });
  watchRejoin(client);
  client.connect();

  return {
    get client() {
      return client;
    },
    onReplace(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      closed = true;
      client.disconnect();
      await saver.stop();
      claim.release();
      markClosed();
    },
  };
}
