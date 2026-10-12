# CollabPad: Requirements Analysis

> Source: `PRD/v1.txt` (v1 project idea)
> Product goal: a Google-Docs-style online notepad where several people can read and write the same document at the same time. It keeps working offline and always converges to the same text.
> Engineering goal (resume angle): build the sync engine **from first principles**. That means a hand-written sequence CRDT (RGA), a relay server, anti-entropy, a fault-injection test harness and measured overhead numbers. **No Yjs / Automerge / ShareDB.**

---

## 1. Breakdown of the original PRD

Each phrase in `v1.txt` maps to one concrete requirement:

| # | PRD phrase | What it really means | Req IDs |
|---|-----------|----------------------|---------|
| 1 | "Implement a sequence CRDT such as RGA" | Write the Replicated Growable Array ourselves: a linked sequence ordered by unique IDs, with a deterministic tie-break | FR-1..FR-4 |
| 2 | "unique character identifiers" | Every character gets a globally unique, immutable ID `(replicaId, counter)` plus a Lamport timestamp for ordering | FR-1 |
| 3 | "insertions, and deletion tombstones" | Inserts reference a left origin. Deletes mark the element as deleted but keep it, because later ops may still reference it | FR-2, FR-3 |
| 4 | "minimal editor" | A browser editor that maps keystrokes to CRDT ops and remote ops back to editor changes | FR-10..FR-14 |
| 5 | "relay that persists and forwards operations between three clients" | A server that stores the op log durably and broadcasts it. The relay is **not** an authority and does no transformation. Must work for at least 3 concurrent clients | FR-20..FR-24 |
| 6 | "Allow offline editing" | Clients keep editing with no connection. Local ops are queued and survive a page reload | FR-15, FR-16 |
| 7 | "exchange missing operations after reconnection using per-replica sequence summaries" | Anti-entropy with **version vectors** `{replicaId → highest contiguous seq}`. Peers exchange vectors and send only the delta | FR-25, FR-26 |
| 8 | "shuffled, delayed, and duplicated orders … verify that document hashes converge" | A deterministic network simulator plus property-based tests. Assert `hash(replicaA) == hash(replicaB) == hash(replicaC)` | QA-1..QA-4 |
| 9 | "Demonstrate concurrent insertion and deletion at the same position" | Scripted, reproducible scenarios, shown both in tests and visually in the UI (demo mode) | QA-5, QA-6 |
| 10 | "report synchronization bytes and metadata growth" | Instrumentation plus a benchmark report: bytes on the wire per op and per reconnect, CRDT metadata bytes per visible character, tombstone ratio over time | M-1..M-5 |
| 11 | "state when tombstones may safely be removed" | A written correctness argument (causal stability) **and** an implemented, test-covered GC | FR-5, DOC-2 |
| 12 | Concepts: CRDTs, causality, SEC, anti-entropy, idempotency, tombstones | Each concept must be visible in code, tests and the README (see §7 traceability) | — |

---

## 2. Product scope ("Google Docs-like")

### 2.1 In scope (MVP)
- Create a document and get a shareable URL (`/d/:docId`). Anyone with the link can edit.
- 3 or more people editing the same doc at once, with live updates (target < 150 ms on the same region).
- **Presence:** who is online, colored remote cursors and selections, name labels.
- **Connection status badge:** `Online` / `Offline – N changes pending` / `Syncing…`.
- **Offline editing:** keep typing with the network off. Changes merge automatically on reconnect and survive a page refresh.
- Document list (recent docs on this device) and a doc title that is editable.
- Plain text only (a notepad, not rich text).

### 2.2 Stretch (post-MVP, extra resume value)
- Lightweight auth (display name + optional GitHub OAuth). Read-only share links.
- Per-user undo/redo that only undoes *your* ops (selective undo over the CRDT).
- Version history / time travel, by replaying the op log up to time T.
- Block-wise / run-length-encoded RGA for large docs (Yjs-style items).
- Binary wire format (varint + MessagePack), compared against JSON in the report.
- Horizontal scaling of the relay with Redis pub/sub.

### 2.3 Out of scope
- Rich text (bold, headings), images, comments, suggestions mode.
- Peer-to-peer WebRTC transport. The relay topology is enough, and the CRDT is transport-agnostic.
- Byzantine/malicious replicas. We trust clients not to forge IDs, and only validate format.

---

## 3. Functional requirements

### 3.1 CRDT core (`packages/crdt`). Pure TypeScript, zero dependencies.

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-1 | **Element identity.** Each inserted character has `id = {replica: string, seq: uint}` (unique, used for delivery and dedup) and `ts = {lamport: uint, replica}` (total order, used for tie-breaks) | IDs are never reused. `seq` is strictly contiguous per replica. Lamport is `max(seen)+1` |
| FR-2 | **Insert op** `{type:'ins', id, ts, origin: ElementId \| HEAD, char}`. Integration is RGA: go to `origin`, skip right past elements whose `ts > op.ts`, then place the new element | Two concurrent inserts at the same origin always end up in the same order on every replica |
| FR-3 | **Delete op** `{type:'del', id, target: ElementId}` sets `target.deleted = true` (a tombstone). It is never physically removed during normal operation | Inserts that reference a tombstone as origin still integrate correctly |
| FR-4 | **Idempotency and causal delivery.** An op whose `seq ≤ vv[replica]` is a duplicate and is dropped. An op whose dependencies are missing (previous seq from the same replica, its origin, or its delete target) goes into a **pending buffer** and is applied once ready | Delivering any op twice or more leaves the state unchanged. Delivering ops in any order gives the same final state |
| FR-5 | **Tombstone GC.** A tombstone may be purged only when its delete is **causally stable** (see §6). Implemented as `compact(stableVector)` | GC never changes the visible text. After GC, ops arriving later still integrate (guaranteed by the stability precondition) |
| FR-6 | **Local API:** `insertAt(index, text)`, `deleteRange(index, len)`, `toString()`, `applyRemote(op[])`, `versionVector()`, `opsSince(vv)`, `snapshot()` / `load()` | Index↔ID mapping is correct for visible-only positions |
| FR-7 | **Deterministic hash:** `stateHash()` = SHA-256 of the visible text, and `fullHash()` = SHA-256 of the canonical serialization including tombstones | Used by all convergence tests |
| FR-8 | **Cursor anchoring:** convert between an index and a stable `ElementId` anchor so remote cursors don't drift | A remote cursor stays next to the same character while others edit before it |

### 3.2 Editor client (`apps/web`)

| ID | Requirement |
|----|-------------|
| FR-10 | CodeMirror 6 editor. Local transactions become CRDT ops (multi-char paste = N inserts chained by origin, batched in one message) |
| FR-11 | Remote ops become CodeMirror changes without echoing them back as local ops, and the local selection is preserved |
| FR-12 | Presence: remote cursors and selections rendered as decorations, plus an avatar strip of online users |
| FR-13 | Connection status badge with a pending-op count |
| FR-14 | **Demo/Debug panel** (toggle): shows replica ID, version vector, op log, tombstone count, bytes sent and received, and a "simulate offline" switch. *This panel is what sells the project in an interview.* |
| FR-15 | Offline persistence: CRDT snapshot + unacknowledged op queue in IndexedDB. Restored on reload |
| FR-16 | Reconnect with exponential backoff and jitter. Run the anti-entropy handshake on every (re)connect |
| FR-17 | Home page: "New document" button + list of recent docs (local) |

### 3.3 Relay server (`apps/relay`)

| ID | Requirement |
|----|-------------|
| FR-20 | WebSocket endpoint `/ws?doc=:id`. Rooms are keyed by docId |
| FR-21 | **Persist before forward:** append ops to durable storage (SQLite in dev, Postgres optional), then broadcast to the other clients in the room |
| FR-22 | Server-side dedup by `(doc, replica, seq)` primary key, so the relay is also idempotent |
| FR-23 | The relay keeps its own version vector per doc and answers `SYNC_REQUEST(vv)` with the missing ops in per-replica seq order |
| FR-24 | Ephemeral presence messages (cursors) are forwarded but **not** persisted |
| FR-25 | Tracks the **acknowledged vector per replica** (the last vv each client reported). Used to compute causal stability for GC |
| FR-26 | Snapshot + compaction: periodically materialize a doc snapshot so new clients load `snapshot + tail` instead of the full log |
| FR-27 | REST: `POST /api/docs` (create), `GET /api/docs/:id/meta`, `GET /api/docs/:id/stats` (bytes, op counts, tombstones), `GET /healthz` |

### 3.4 Wire protocol (`packages/protocol`)

```
C→S  HELLO        {docId, replicaId, vv}            // on connect
S→C  WELCOME      {serverVV, snapshot?}             // optional snapshot for a fresh client
S→C  OPS          {ops[]}                           // delta = server has, client lacks
C→S  OPS          {ops[]}                           // delta = client has, server lacks + live edits
S→C  ACK          {vv}                              // server durably stored up to vv
C↔S  PRESENCE     {replicaId, name, color, anchor, head}
S→C  STABLE       {stableVV}                        // min over all ack vectors → GC hint
```

---

## 4. Non-functional requirements

| ID | Category | Target |
|----|----------|--------|
| NFR-1 | Convergence (SEC) | 100% hash agreement across ≥ 10,000 randomized fuzz runs (3 replicas, shuffled + delayed + duplicated delivery) |
| NFR-2 | Latency | Local keystroke applied in < 1 ms (p99) for a 10k-char doc. Remote propagation < 150 ms p95 on the same region |
| NFR-3 | Throughput | Replay the **automerge-perf editing trace (~260k ops)** in a measured, reported time |
| NFR-4 | Durability | An op that has been ACKed by the server survives a server crash or restart |
| NFR-5 | Offline | Unlimited offline duration. Pending ops survive a browser reload |
| NFR-6 | Scale (MVP) | 1 relay instance, ≥ 20 concurrent editors per doc, ≥ 100 docs |
| NFR-7 | Code quality | TypeScript strict mode, ≥ 90% line coverage on `packages/crdt`, CI on every PR |
| NFR-8 | Observability | Structured logs (pino). `/stats` endpoint with bytes in/out, ops/sec and tombstone ratio |
| NFR-9 | Security (baseline) | Message schema validation (zod), payload size limits, per-connection rate limit, unguessable doc IDs (nanoid 21) |

---

## 5. Quality and verification requirements (taken straight from the PRD)

| ID | Test | How |
|----|------|-----|
| QA-1 | **Shuffled** delivery | A seeded PRNG permutes the full op set per replica. Assert equal `stateHash` |
| QA-2 | **Delayed** delivery | Simulated network with random per-message latency and partitions (replica offline for K steps) |
| QA-3 | **Duplicated** delivery | Each message is re-delivered 0..3 times at random points. Assert idempotency |
| QA-4 | Property-based fuzz | `fast-check`: arbitrary interleavings of local edits, sync events and duplications. Failing seeds are shrunk and saved as regression fixtures |
| QA-5 | **Concurrent insert at the same position** | A and B both insert at index 5 while partitioned → after sync, both strings are present, contiguous (no interleaving of characters within a run), and in the same order on all replicas |
| QA-6 | **Concurrent insert + delete at the same position** | A deletes the char at index 5 while B inserts right after it → B's insert survives, anchored after the tombstone. Same result everywhere |
| QA-7 | Offline round trip | Client edits offline for N ops, reloads the page, reconnects → only the missing ops are exchanged (assert the byte count) |
| QA-8 | Tombstone GC safety | Fuzz with GC enabled at random stable points → same hashes as without GC |
| QA-9 | E2E | Playwright: 3 browser contexts edit the same doc, one goes offline, all converge |
| QA-10 | Relay restart | Kill the relay mid-session and restart it → clients resync from the persisted log with no loss |

---

## 6. Tombstone removal: the safety condition (DOC-2)

> **Update (implementation):** the condition below turned out to be incomplete. Removing a tombstone can also change where a later concurrent insert lands. The implemented rule adds a two-round protocol and an RGA neighbour condition. See [`docs/TOMBSTONES.md`](../docs/TOMBSTONES.md).

**Why tombstones exist:** a remote insert may name a deleted character as its `origin`. If that character were gone, the insert could not be placed deterministically.

**When a tombstone for element `e` (deleted by op `d`) can be removed:**

1. `d` is **causally stable**: every replica in the membership set has delivered `d`. Formally, `d.id.seq ≤ min_r ackVV[r][d.id.replica]`.
2. No op that is still undelivered anywhere can reference `e`. Because each replica reports its ack vector *including its own seq*, and the relay delivers per-replica in FIFO order, condition 1 implies that every replica had already seen `d` when it generated any op still in flight. Those ops cannot use a deleted element as origin, since inserts take the left *visible* neighbor. Ops created **before** seeing `d` have seqs ≤ the reported vector, so they are already delivered at the GC'ing replica. The GC'ing replica must therefore also satisfy `localVV ≥ stableVV`.
3. When `e` is purged, any **visible** element whose `origin == e` is re-pointed to `e`'s nearest surviving left ancestor (or `HEAD`). Ordering is preserved because every op that could still be compared against them is already integrated.

**Practical caveat (documented in the README):** one replica that stays offline forever blocks stability. Mitigation: membership leases. A replica unseen for T days is evicted from the stable-vector computation. If it later returns, it must **re-bootstrap from a snapshot** and re-submit its pending ops **rebased as fresh inserts** ("rejoin" path), rather than merging raw ops.

---

## 7. Metrics to report (M-1..M-5) → `docs/REPORT.md`

| ID | Metric | Measured by |
|----|--------|-------------|
| M-1 | Sync bytes per op (JSON vs binary encoding, single char vs run-length) | Byte counters in the protocol layer |
| M-2 | Reconnect cost: bytes exchanged after N offline ops, compared to a full-state transfer | Simulator + E2E |
| M-3 | Metadata growth: (CRDT memory bytes ÷ visible chars) over time | Bench on the editing trace, sampled every 10k ops |
| M-4 | Tombstone ratio (tombstones ÷ total elements) before and after GC | Same bench |
| M-5 | Integration time per op (p50/p99) and total trace replay time | `tinybench` |

Each metric is shown in a chart plus a sentence of interpretation in the report.

---

## 8. Traceability: concept → where it is proved

| Concept | Code | Test | Doc |
|---------|------|------|-----|
| CRDT (RGA) | `crdt/src/rga.ts` | QA-1..6 | README "How it works" |
| Causality | Lamport clock, pending buffer, version vectors | QA-2, QA-4 | §6 |
| Strong eventual consistency | `stateHash` | QA-1..4, NFR-1 | README |
| Anti-entropy | `opsSince(vv)`, HELLO/SYNC handshake | QA-7, QA-10 | Protocol doc |
| Idempotency | seq dedup (client + server PK) | QA-3 | — |
| Tombstones | `deleted` flag, `compact()` | QA-6, QA-8 | §6 + REPORT M-4 |

---

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| O(n) index→element lookup makes large docs slow | Laggy typing | Phase 1 uses an array + id→index map. Phase 6 moves to a run-length block list / counted B-tree |
| Interleaving anomaly (two users' concurrent words mixed letter by letter) | Bad UX | RGA with origin chaining keeps runs contiguous. Covered by a QA-5 assertion. Mention the Fugue/YATA comparison in the README |
| The CodeMirror ↔ CRDT echo loop | Duplicate text | Tag remote transactions with an annotation and skip them in the update listener |
| GC bug corrupts docs | Data loss | GC behind a flag, fuzzed (QA-8), server keeps the full log as source of truth |
| Scope creep (rich text, auth) | Never finishes | MVP is strictly plain text. Stretch list is ordered |

---

## 10. Definition of done (resume-ready)

- [ ] Live demo URL (deploy configs ready: `fly.toml`, `render.yaml`; needs an account)
- [x] Demo GIF: two browsers, one offline, both converge (`docs/demo.gif`)
- [x] README: architecture diagram, how it works, tombstone-GC argument, metric charts
- [x] `docs/REPORT.md` with M-1..M-5 numbers taken from real runs
- [ ] CI badge (green): unit + fuzz (10k seeds) + E2E (workflows written; not yet run on GitHub)
- [x] Clean monorepo, strict TS, ≥ 90% coverage on the CRDT package
- [x] 3–4 quantified resume bullets (`03-resume-notes.md`)
