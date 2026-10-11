# CollabPad — Real-Time Collaborative Text Editor

A Google-Docs-style notepad where several people edit the same document at once, online or
offline, built on a **from-scratch RGA sequence CRDT** (no Yjs / Automerge).

> Status: Phase 1 of 7 — CRDT core done. See [`PRD/`](PRD) for the requirements and plan.

## Packages

| Package                          | What                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/crdt`](packages/crdt) | RGA with unique `(replica, seq)` ids, Lamport-stamped ordering, deletion tombstones, version vectors, causal buffering, idempotent delivery, SHA-256 state hashes |

## How the CRDT works (short)

- Every character is an element with a unique id `(replica, seq)` and a Lamport stamp.
- An insert names its left neighbour (`origin`). To integrate, go to the origin and skip right
  past every element with a larger stamp. Concurrent inserts at the same spot end up in the same
  order everywhere, and each user's run of text stays contiguous.
- A delete only marks the element as a tombstone, so later inserts can still use it as an origin.
- Ops can arrive shuffled, delayed or duplicated: duplicates are dropped by the version vector,
  and ops whose dependencies are missing wait in a pending buffer.
- Reconnecting replicas exchange version vectors and send only `opsSince(vv)`.

## Development

```bash
corepack enable        # or prefix commands with `corepack`
pnpm install
pnpm test              # unit + convergence tests
pnpm coverage
pnpm lint && pnpm typecheck
```
