import type { Op, ReplicaId } from '@collabpad/crdt';

/**
 * Synchronous write-ahead journal for the moment a page is being torn down.
 *
 * IndexedDB writes are async, and browsers do not wait for them during a reload or tab close,
 * so ops typed in the last few hundred ms could be lost. On `pagehide` we write every op made
 * since the last IndexedDB save to localStorage (synchronous, always completes), and replay it
 * on top of the snapshot at the next load. Remote ops are included too, so every journaled op's
 * dependencies are present when it is replayed.
 */
const key = (docId: string, replica: ReplicaId) => `collabpad:journal:${docId}:${replica}`;

export function writeJournal(docId: string, replica: ReplicaId, ops: readonly Op[]): void {
  try {
    if (ops.length) localStorage.setItem(key(docId, replica), JSON.stringify(ops));
  } catch {
    // Quota or storage disabled: fall back to whatever IndexedDB managed to save.
  }
}

export function readJournal(docId: string, replica: ReplicaId): Op[] {
  try {
    return JSON.parse(localStorage.getItem(key(docId, replica)) ?? '[]') as Op[];
  } catch {
    return [];
  }
}

export function clearJournal(docId: string, replica: ReplicaId): void {
  try {
    localStorage.removeItem(key(docId, replica));
  } catch {
    // ignore
  }
}
