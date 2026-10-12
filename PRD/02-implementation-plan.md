# CollabPad: Implementation Plan

Companion to `01-requirements-analysis.md`. Requirement IDs (FR-x, QA-x, M-x) refer to that file.

---

## 1. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | **TypeScript (strict)** everywhere | One CRDT package shared by browser, server and tests |
| Monorepo | pnpm workspaces + Turborepo | Shared packages, cached builds |
| CRDT core | Hand-written, **zero deps** | The point of the project |
| Editor | React + Vite + **CodeMirror 6** | Clean transaction API, decorations for remote cursors |
| Client storage | IndexedDB (`idb`) | Offline snapshot + pending queue |
| Relay | Node 20 + `ws` + Fastify (REST) | Light and explicit. No socket.io magic |
| DB | SQLite (`better-sqlite3`, WAL) → Postgres optional | Append-only op log, simple to run |
| Validation | `zod` | Schema-check every inbound message |
| Tests | Vitest, **fast-check** (property tests), Playwright (E2E) | — |
| Bench | `tinybench` + automerge-perf editing trace | Credible, comparable numbers |
| Ops | Docker Compose, GitHub Actions, deploy on Fly.io / Render (relay) + Vercel/Netlify (web) | — |

## 2. Repository layout

```
RTC_TextEditor/
├─ packages/
│  ├─ crdt/            # RGA, clocks, version vectors, GC, hashing   (no deps)
│  │  ├─ src/{ids.ts, clock.ts, vv.ts, rga.ts, doc.ts, gc.ts, hash.ts, encode.ts}
│  │  └─ test/
│  ├─ protocol/        # message types, zod schemas, JSON + binary codecs, byte counters
│  └─ sim/             # deterministic network simulator + fuzz harness + scenarios
├─ apps/
│  ├─ relay/           # WebSocket relay + REST + SQLite persistence
│  └─ web/             # React + CodeMirror client
├─ bench/              # trace replay, metric collection → CSV → charts
├─ docs/               # ARCHITECTURE.md, PROTOCOL.md, REPORT.md, TOMBSTONES.md
├─ e2e/                # Playwright tests
├─ docker-compose.yml
└─ .github/workflows/ci.yml
```

## 3. Architecture

```
 ┌──────────── Browser (×3+) ────────────┐                 ┌──────────── Relay ─────────────┐
 │ CodeMirror ⇄ Binding ⇄ CRDT Doc (RGA)  │   WebSocket     │ Room(docId)                     │
 │                   │        ▲           │  HELLO{vv}  ──▶ │  ├─ serverVV                     │
 │                   ▼        │           │  ◀── OPS(delta) │  ├─ ackVV per replica ─▶ stableVV│
 │            Outbox (pending ops)        │  OPS(live)  ──▶ │  ├─ persist → broadcast          │
 │                   │                    │  ◀── ACK{vv}    │  └─ presence (memory only)       │
 │            IndexedDB (snapshot+queue)  │  ◀─▶ PRESENCE   │ SQLite: ops, snapshots, docs     │
 └────────────────────────────────────────┘                 └────────────────────────────────┘
```

The relay never transforms ops. All merge logic lives in the CRDT, so the server is a durable, idempotent mailbox with a version vector.

## 4. Core data model (packages/crdt)

```ts
type ReplicaId = string;                       // nanoid(10), persisted per browser per doc
interface ElemId { replica: ReplicaId; seq: number }        // delivery identity
interface Stamp  { lamport: number; replica: ReplicaId }    // ordering (total order)

interface InsertOp { type:'ins'; id:ElemId; ts:Stamp; origin:ElemId|null; char:string }
interface DeleteOp { type:'del'; id:ElemId; ts:Stamp; target:ElemId }
type Op = InsertOp | DeleteOp;

interface Elem { id:ElemId; ts:Stamp; origin:ElemId|null; char:string; deleted:boolean }

type VersionVector = Record<ReplicaId, number>;            // highest *contiguous* seq applied
```

**Doc state:** `elems: Elem[]` in document order, plus `index: Map<idKey, Elem>`, plus `vv`, plus `pending: Op[]`, plus `log` (ops by replica, for `opsSince`).

**RGA integrate(ins):**
```
pos = (origin == null) ? 0 : indexOf(origin) + 1
while pos < elems.length and cmp(elems[pos].ts, ins.ts) > 0:   // skip "newer" concurrent siblings & their subtrees
    pos++
elems.splice(pos, 0, newElem)
```
`cmp` compares lamport first, then the replica string. Because Lamport clocks make children always larger than their origin, skipping all larger stamps skips whole sibling subtrees. That is what makes the order deterministic.

**applyRemote(op):**
1. If `op.id.seq ≤ vv[op.id.replica]` → duplicate, drop (**idempotency**).
2. If `op.id.seq ≠ vv[r]+1`, or its origin/target is unknown → push to `pending` (**causal delivery**).
3. Otherwise integrate, bump `vv[r]`, set `lamport = max(lamport, op.ts.lamport)`, append to the log, then retry `pending` until no progress.

## 5. Phased plan

Estimates assume about 10–15 hrs/week. Each phase ends with something demoable and committed.

### Phase 0: Scaffolding (½ week)
- pnpm monorepo, TS strict, ESLint/Prettier, Vitest, Turborepo.
- GitHub Actions: lint + typecheck + test.
- `docs/ARCHITECTURE.md` skeleton (copy §3).
- **Exit:** `pnpm test` is green in CI with one placeholder test.

### Phase 1: CRDT core (1.5 weeks) · FR-1..FR-4, FR-6..FR-8
1. `clock.ts`: Lamport clock. `vv.ts`: merge, compare, `dominates`, `min` over vectors.
2. `rga.ts`: the element list, `integrateInsert`, `integrateDelete`, visible index ↔ ElemId.
3. `doc.ts`: `insertAt`, `deleteRange`, `applyRemote` with dedup and pending buffer, `opsSince(vv)`, `snapshot/load`.
4. `hash.ts`: `stateHash` (visible text) and `fullHash` (canonical including tombstones). Uses WebCrypto/Node crypto.
5. Unit tests: sequential edits, two-replica merges, the QA-5 and QA-6 scenarios written as named tests.
- **Exit:** two in-memory docs exchange ops in any order and converge. Coverage ≥ 90%.

### Phase 2: Simulator and convergence proof (1 week) · QA-1..QA-4, QA-8 (later)
1. `packages/sim`: `Network` with a seeded PRNG (`mulberry32`). Message queue with per-message delay, **shuffle**, **duplicate (0–3×)**, and **partition(replica, steps)**.
2. `Scenario` DSL: `A.type(5,"hello"); net.partition(B); B.del(5,1); net.heal(); assertConverged()`.
3. fast-check property: `∀ seed, ∀ action sequence → all replicas' stateHash are equal after quiescence`. Run 1k in PR CI and 10k nightly.
4. Save shrunk failing seeds to `test/regressions/*.json`.
- **Exit:** a `pnpm fuzz --runs 10000` log shows 0 divergences. This output goes into the README.

### Phase 3: Protocol and relay (1.5 weeks) · FR-20..FR-27
1. `packages/protocol`: zod schemas for HELLO/WELCOME/OPS/ACK/PRESENCE/STABLE, a JSON codec, and a `ByteCounter` wrapper.
2. SQLite schema:
   ```sql
   CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER);
   CREATE TABLE ops (
     doc_id TEXT, replica TEXT, seq INTEGER, lamport INTEGER,
     payload BLOB, received_at INTEGER,
     PRIMARY KEY (doc_id, replica, seq)          -- server-side idempotency
   );
   CREATE TABLE snapshots (doc_id TEXT, vv TEXT, state BLOB, created_at INTEGER);
   CREATE TABLE replica_acks (doc_id TEXT, replica TEXT, vv TEXT, last_seen INTEGER,
     PRIMARY KEY (doc_id, replica));
   ```
3. Room lifecycle: load the server VV on the first join. On `HELLO{vv}`, send `opsSince(vv)` in seq order. On `OPS`, insert with `ON CONFLICT DO NOTHING`, then broadcast only the newly stored ops, then `ACK`.
4. Store `replica_acks` from every HELLO/ACK. Compute `stableVV = min(ackVVs of non-evicted replicas)` and broadcast `STABLE` when it advances.
5. REST endpoints plus `/stats`.
6. Integration test: 3 headless `Doc` clients over real WebSockets against the relay, plus QA-10 (kill and restart the relay).
- **Exit:** a CLI script `pnpm demo:3clients` shows three Node clients converging through the relay.

### Phase 4: Web editor (2 weeks) · FR-10..FR-17
1. Vite + React app with routes `/` (home, new doc, recent docs) and `/d/:docId`.
2. **CodeMirror binding** (`useCrdtBinding`):
   - Local: `updateListener` → for each `ChangeSet` → `deleteRange` + `insertAt` → ops go to the outbox.
   - Remote: ops → visible index changes → `view.dispatch({changes, annotations: Remote.of(true)})`. Skip annotated transactions in the listener (no echo).
3. `SyncClient`: WebSocket with backoff and jitter, the HELLO handshake, an outbox that is flushed on ACK, and status events.
4. Offline: persist snapshot + outbox to IndexedDB (debounced 500 ms). Restore on load *before* connecting.
5. Presence: cursor anchored by `ElemId` (FR-8), throttled 50 ms, rendered with CodeMirror decorations and name tooltips. Avatar strip.
6. Status badge plus the **Debug panel** (FR-14): VV table, live op log, bytes in/out, tombstone count, a "Go offline" toggle, and a "Run QA-5/QA-6 demo" button.
- **Exit:** open 3 tabs, toggle one offline, type in all three, reconnect → identical text with matching hashes shown in the debug panel.

### Phase 5: Tombstone GC (1 week) · FR-5, QA-8, DOC-2
1. `gc.ts`: `compact(stableVV)` purges tombstones whose delete is ≤ `stableVV` (and `localVV ≥ stableVV`), and re-points the origins of surviving children.
2. The client runs GC when it receives `STABLE`. The relay compacts snapshots with the same rule.
3. Replica eviction lease (configurable, for example 7 days) plus the "rejoin from snapshot" path for evicted replicas.
4. QA-8 fuzz: GC at random stable points → hashes are identical to the no-GC run.
5. Write `docs/TOMBSTONES.md` (expanded from requirements §6).
- **Exit:** the tombstone ratio drops after GC in the bench, and the fuzz is still 0 divergences.

### Phase 6: Performance and metrics (1.5 weeks) · M-1..M-5, NFR-2/3
1. **Run-length items:** consecutive chars from the same replica with consecutive seqs are stored as one item `{id, len, text, deletedMask}`. Split on insert or delete in the middle. This is the biggest win for both memory and bytes.
2. Index structure: replace the linear scan with a chunked list (blocks of about 64 items with visible-length counts) or a counted B-tree, giving O(√n) or O(log n) index↔position.
3. Binary codec: varint-encoded ops, replica IDs interned per message. Compare against JSON.
4. `bench/`: replay the **automerge-perf** trace (`paper.json`, ~260k edits), sampling memory, tombstones and time every 10k ops. Also run a synthetic 3-replica offline-reconnect bench for M-2.
5. Produce CSVs → charts (Vega-Lite / matplotlib) → `docs/REPORT.md`.
- **Exit:** the report has real before/after numbers (naive vs RLE, JSON vs binary).

### Phase 7: Polish, E2E, deploy (1 week) · QA-9, DoD
1. Playwright: 3 contexts with offline emulation (`context.setOffline(true)`), asserting equal text.
2. Docker Compose (relay + web). Deploy the relay to Fly.io/Render with a persistent volume, and the web app to Vercel/Netlify.
3. Hardening: zod validation, a 256 KB message cap, a token-bucket rate limit, nanoid doc IDs.
4. README: hero GIF, live link, architecture diagram, "How RGA works" (with a small diagram of the QA-5/QA-6 cases), metrics charts, "Design decisions and trade-offs" (RGA vs OT vs Fugue/YATA), and how to run it.
- **Exit:** everything in the Definition of Done (requirements §10) is ticked.

**Total: about 10 weeks part-time.** If time is short, stop after Phase 5 (all PRD items done) and do Phase 6 items 1 and 4 only.

## 6. Testing strategy summary

| Layer | Tool | What |
|-------|------|------|
| Unit | Vitest | Clock, VV, RGA integrate, index mapping, GC |
| Scenario | Vitest + sim DSL | QA-5, QA-6, QA-7 as readable named tests |
| Property | fast-check + sim | QA-1..4, QA-8 (1k runs in CI, 10k nightly) |
| Integration | Vitest + real relay | 3 Node clients, relay restart (QA-10) |
| E2E | Playwright | 3 browsers, offline/online (QA-9) |
| Bench | tinybench | M-1..M-5 |

## 7. Key design decisions to explain in interviews

1. **CRDT over OT:** no central transform server, so offline editing works and the relay stays simple and idempotent.
2. **Separate `(replica, seq)` from the Lamport stamp:** seq gives contiguous version vectors for cheap anti-entropy, and Lamport gives a causal total order for RGA tie-breaks.
3. **Causal buffer instead of assuming FIFO transport:** correctness does not depend on the network, which is proven by the shuffle/duplicate fuzz.
4. **Tombstones until causal stability:** an explicit safety proof, plus a liveness trade-off (eviction leases).
5. **Run-length items:** cut metadata from about N bytes/char to about N bytes/run (put the measured number in the report).

## 8. Resume bullet templates (fill in from REPORT.md)

> **Done:** the final bullets with measured numbers are in [`03-resume-notes.md`](03-resume-notes.md).

- Built **CollabPad**, a real-time collaborative text editor (TypeScript, React, CodeMirror, WebSockets), powered by a **from-scratch RGA sequence CRDT** with Lamport-ordered unique IDs and deletion tombstones. It supports offline editing and conflict-free merging across any number of clients.
- Designed a **version-vector anti-entropy protocol** and an idempotent persist-then-forward relay (Node, SQLite). Reconnecting after *N* offline edits transfers only the missing ops, **X× fewer bytes** than a full-state sync.
- Proved **strong eventual consistency** with a deterministic network simulator and property-based tests (fast-check): **10,000+ randomized runs** with shuffled, delayed and duplicated delivery, 0 divergences.
- Implemented **causal-stability-based tombstone GC** and run-length element encoding, cutting CRDT metadata by **Y%** and replaying a 260k-op real editing trace in **Z s**.

## 9. Immediate next steps

1. Phase 0 scaffolding (monorepo + CI).
2. Write `ids.ts`, `clock.ts`, `vv.ts` with tests.
3. Write `rga.ts` integrate, plus the QA-5 and QA-6 tests, before anything else. They are the heart of the project.
