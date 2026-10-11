import { SyncClient } from '@collabpad/client';
import { Doc, vvEquals, type VersionVector } from '@collabpad/crdt';
import { wsUrl } from '../lib/api';
import { clearJournal, readJournal, writeJournal } from './journal';
import { claimReplica } from './storage';

const SAVE_DEBOUNCE_MS = 500;

/**
 * Sessions for the same doc run one after another, so a remount (React StrictMode, fast
 * navigation) reclaims the same replica lock instead of racing for it.
 */
const lastClosed = new Map<string, Promise<void>>();

export interface Session {
  readonly client: SyncClient;
  close(): Promise<void>;
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

  const claim = await claimReplica(docId);
  const doc = claim.snapshot ? Doc.load(claim.replica, claim.snapshot) : new Doc(claim.replica);
  const journal = readJournal(docId, claim.replica);
  doc.applyRemote(journal);
  const client = new SyncClient({ url: wsUrl(), docId, doc });

  /** Vector covered by the last completed IndexedDB save. */
  let savedVV: VersionVector = claim.snapshot ? doc.versionVector() : {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    const vv = doc.versionVector();
    if (vvEquals(vv, savedVV)) return;
    await claim.save(doc.snapshot());
    savedVV = vv;
    clearJournal(docId, claim.replica);
  };
  const scheduleSave = () => {
    timer ??= setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  };
  // Teardown: journal synchronously (always completes), then attempt the async save as well.
  const onPageHide = () => {
    writeJournal(docId, claim.replica, doc.opsSince(savedVV));
    void flush();
  };
  const onHide = () => document.visibilityState === 'hidden' && onPageHide();

  if (journal.length) {
    savedVV = {}; // force the replayed ops into IndexedDB
    void flush();
  }

  const off = [client.on('local', scheduleSave), client.on('remote', scheduleSave)];
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  client.connect();

  return {
    client,
    async close() {
      off.forEach((fn) => fn());
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      client.disconnect();
      await flush();
      claim.release();
      markClosed();
    },
  };
}
