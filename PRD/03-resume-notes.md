# Resume notes: CollabPad

## One line

Real-time collaborative text editor (Google-Docs-style) built on a from-scratch RGA sequence
CRDT, with offline editing, provably safe tombstone GC and a binary sync protocol.

**Stack:** TypeScript, React, CodeMirror 6, Node.js, Fastify, WebSockets, SQLite, IndexedDB,
Vitest, fast-check, Playwright, GitHub Actions.

## Bullets (pick 3–4)

- Built **CollabPad**, a real-time collaborative editor (TypeScript, React, CodeMirror,
  WebSockets) on a **from-scratch RGA sequence CRDT** (no Yjs/Automerge). It supports live
  cursors, offline editing that survives reloads, and conflict-free merging across any number of
  clients.
- Designed a **version-vector anti-entropy protocol** with a **binary wire format** and a
  persist-then-forward Node/SQLite relay. That means **24 B per keystroke** (7× smaller than
  JSON) and **110 B to resync after 10 offline edits**, versus a 629 KB full snapshot.
- Proved **strong eventual consistency** with a deterministic network simulator and
  property-based tests. **10,000 randomized runs** with reordered, duplicated and dropped messages
  and network partitions ended in 0 divergences, and every safety rule was confirmed by mutation
  testing.
- Found that the textbook tombstone-GC rule is unsafe for RGA. Designed a **two-round
  causal-stability protocol** with a neighbour condition, and documented the proof and the
  counterexample. GC cut snapshots by **58%** and per-replica memory from **51.6 MB to 1.3 MB**.
- Re-engineered the CRDT with **run-length items and a chunked index**. It replays the
  **259,778-edit automerge-paper trace in 1.44 s** (p50 1.2 µs per edit), **7× faster** than the
  per-character version, and a differential test keeps the two identical.

## Stories for interviews

1. **"Everyone has seen the delete" is not enough.** Removing an old tombstone can change where a
   later concurrent insert lands, because RGA's scan stops at old elements. I built the exact
   schedule (`ONY` vs `OYN`), added a neighbour rule and a second stability round, and confirmed
   each by mutation. Random fuzzing never found the trap: with FIFO WebSockets through one relay
   it can't happen. So I kept it as a fixed test example and explained why.
   ([TOMBSTONES.md](../docs/TOMBSTONES.md))
2. **The benchmark found two production bugs.** First, `push(...ops)` on 260k ops overflowed the
   call stack. Second, catching up 200k ops took 512 s, because buffered ops were rescanned on
   every arrival. I replaced the rescan with a dependency-indexed wait queue, and it now takes
   milliseconds.
3. **Offline edits vanished on reload, but only sometimes.** I instrumented the run instead of
   guessing. The new page claimed a fresh replica before the old page released its Web Lock, so
   the unsent ops sat under the old id. The fix: remember the tab's replica in `sessionStorage`,
   wait for its lock, and journal synchronously on `pagehide`.
4. **Testing a distributed system without flakes.** I used a seeded simulator with failures that
   shrink to minimal cases, a differential oracle for the optimized data structure, and E2E tests
   that run in CI against the production build.

## Links to add

- GitHub repo: <https://github.com/ViserionBuild/RTC_TextEditor>
- Live demo: deploy with `render.yaml` and put the URL here and in the README.
