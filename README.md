# CollabPad — Real-Time Collaborative Text Editor

A Google-Docs-style notepad where several people edit the same document at once, online or
offline, built on a **from-scratch RGA sequence CRDT** (no Yjs / Automerge).

> Status: Phase 2 of 7 — CRDT core and convergence simulator done. See [`PRD/`](PRD) for the requirements and plan.

## Packages

| Package                          | What                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/crdt`](packages/crdt) | RGA with unique `(replica, seq)` ids, Lamport-stamped ordering, deletion tombstones, version vectors, causal buffering, idempotent delivery, SHA-256 state hashes |
| [`packages/sim`](packages/sim)   | Deterministic network simulator (latency, reordering, duplication, loss, outages) with a relay, plus a fast-check convergence fuzzer                              |

## How the CRDT works (short)

- Every character is an element with a unique id `(replica, seq)` and a Lamport stamp.
- An insert names its left neighbour (`origin`). To integrate, go to the origin and skip right
  past every element with a larger stamp. Concurrent inserts at the same spot end up in the same
  order everywhere, and each user's run of text stays contiguous.
- A delete only marks the element as a tombstone, so later inserts can still use it as an origin.
- Ops can arrive shuffled, delayed or duplicated: duplicates are dropped by the version vector,
  and ops whose dependencies are missing wait in a pending buffer.
- Reconnecting replicas exchange version vectors and send only `opsSince(vv)`.

## Convergence testing

`pnpm fuzz` runs 10,000 random scenarios: 3 replicas behind a relay make random edits (about
100 ops per run) while the network reorders, duplicates (up to 4 copies) and drops messages and
replicas go offline. After everyone reconnects and anti-entropy settles, all replicas and the
relay must have identical version vectors and identical SHA-256 hashes of the full state,
tombstones included. Failures shrink to a minimal case that can be saved to
`packages/sim/test/regressions/`.

## Development

```bash
corepack enable        # or prefix commands with `corepack`
pnpm install
pnpm test              # unit + scenario tests + 300-run fuzz
pnpm fuzz              # 10,000-run fuzz
pnpm coverage
pnpm lint && pnpm typecheck
```
