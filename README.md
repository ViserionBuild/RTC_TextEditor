# CollabPad — Real-Time Collaborative Text Editor

A Google-Docs-style notepad where several people edit the same document at once, online or
offline, built on a **from-scratch RGA sequence CRDT** (no Yjs / Automerge).

> Status: Phase 4 of 7 — CRDT core, convergence simulator, relay server and web editor done. See [`PRD/`](PRD) for the requirements and plan.

## Packages

| Package                                  | What                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/crdt`](packages/crdt)         | RGA with unique `(replica, seq)` ids, Lamport-stamped ordering, deletion tombstones, version vectors, causal buffering, idempotent delivery, SHA-256 state hashes |
| [`packages/sim`](packages/sim)           | Deterministic network simulator (latency, reordering, duplication, loss, outages) with a relay, plus a fast-check convergence fuzzer                              |
| [`packages/protocol`](packages/protocol) | Wire messages (zod-validated), close codes, byte counters                                                                                                         |
| [`packages/client`](packages/client)     | `SyncClient`: connects a Doc to the relay (browser + Node), reconnect with backoff, pending-op tracking, presence                                                 |
| [`apps/relay`](apps/relay)               | Fastify + WebSocket relay; persists ops to SQLite (`node:sqlite`) before forwarding; REST API; rate limiting; stability vector                                    |
| [`apps/web`](apps/web)                   | React + CodeMirror 6 editor: live remote cursors, status badge, offline persistence (IndexedDB + teardown journal + Web Locks), "Internals" debug panel           |

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

## Relay protocol

```
client → relay   hello{replica, vv}   first frame: who I am, what I have
relay  → client  ops[missing] + sync{relayVV} + stable{vv}
client → relay   ops[what the relay lacks]  (only ops this replica authored)
client → relay   ops[live edits]            relay persists, forwards, replies ack{vv}
client → relay   sync{vv}                   periodic anti-entropy (repairs lost frames)
client ↔ relay   presence / presence-left   cursors, not persisted
```

REST: `POST /api/docs`, `GET|PATCH /api/docs/:id`, `GET /api/docs/:id/stats`, `GET /healthz`.

## Offline persistence in the browser

- Each tab is its own replica. Its CRDT snapshot, including ops the relay has not acknowledged,
  is saved to IndexedDB (debounced).
- Browsers do not wait for async IndexedDB writes during a reload, so on `pagehide` the ops
  since the last save are also written synchronously to a localStorage journal and replayed at
  the next load.
- A Web Lock per replica stops two tabs from sharing a replica id. A reloading tab remembers its
  replica in sessionStorage and waits for the old page's lock, so unsent ops are never orphaned.

## Development

```bash
corepack enable        # or prefix commands with `corepack`
pnpm install
pnpm test              # unit + scenario tests + 300-run fuzz
pnpm fuzz              # 10,000-run fuzz
pnpm relay             # relay on :8787 (DB_PATH, PORT, CORS_ORIGIN, ...)
pnpm demo:3clients     # three headless clients, one goes offline, all converge
pnpm dev               # relay on :8787 + web app on http://localhost:5173
pnpm e2e               # Playwright: real browsers, offline + reload scenarios
pnpm coverage
pnpm lint && pnpm typecheck
```
