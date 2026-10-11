# When can a tombstone be removed?

CollabPad's CRDT never removes a deleted character right away. It marks it as a **tombstone**,
because other replicas may still send operations that refer to it. This document states exactly
when a tombstone can be dropped, why the obvious rule is not enough, and how the implementation
and tests enforce the real one.

Code: [`StabilityTracker`](../packages/crdt/src/stability.ts) (relay side),
[`Doc.collect` / `Rga.purge`](../packages/crdt/src/rga.ts) (every replica).

## Background: how an insert finds its place (RGA)

Every character has an id `(replica, seq)` and a Lamport stamp. An insert names its left
neighbour (its _origin_). To integrate it, a replica starts just after the origin and scans right,
**skipping every element with a larger stamp** and stopping at the first one with a smaller
stamp. Concurrent inserts at the same spot therefore end up in the same order everywhere.

Two things can refer to an existing element:

- an insert's **origin**, and
- a delete's **target**.

## The obvious rule, and why it is wrong

> "A tombstone can be removed once every replica has seen the delete."

That is necessary but not sufficient. Two counterexamples:

**1. Ops still in flight.** Replica B types right after character `e` before it hears that C
deleted `e`. Everyone may have _seen the delete_ while B's insert is still on its way. A replica
that already dropped `e` cannot place B's insert.

**2. The scan can change.** Even when nothing references `e` any more, removing it can change
where a _future_ insert lands. Old elements are stopping points for the scan. Take
`O e Y`, where `e` is a tombstone and `Y` (stamp 43) was typed after `e` by a replica with a fast
clock. A new insert `N` (stamp 4) with origin `O` scans right:

| Replica keeps `e`              | Replica removed `e`                     |
| ------------------------------ | --------------------------------------- |
| `e` has stamp 2 < 4: stop      | `Y` has stamp 43 > 4: skip, stop at end |
| result `O N e Y` → shows `ONY` | result `O Y N` → shows `OYN`            |

The replicas diverge permanently. The test
[`keeps a tombstone whose right neighbour is newer`](../packages/crdt/test/gc.test.ts) builds
exactly this schedule.

## The rule CollabPad uses

A tombstone `e` may be removed by a replica when **all** of these hold:

1. **Frontier.** `e`'s insert and delete are both within a frontier `S` that every live replica
   has seen.
2. **No late references.** The replica has integrated every op in a vector `C`, where `C[R]` is
   replica R's own op count at the moment R first reported having seen `S`.
3. **Old right neighbour.** `e` belongs to a run of removable tombstones whose first surviving
   element to the right was also inserted within `S` (or the run ends the document).

### Why this is safe

- After condition 2, every op this replica has _not_ yet integrated was written by its author
  **after** that author saw `S`. Such an op:
  - never references `e`: when it was written, `e` was already deleted, and inserts and deletes
    only refer to visible characters;
  - has a Lamport stamp larger than every stamp in `S`, because its author had seen all of `S`.
- So for any future insert `N`, every element inserted within `S`, tombstone or not, is a
  stopping point of `N`'s scan.
- Removing a run of such tombstones therefore changes nothing. If `N`'s scan would have stopped at
  the run, it now stops at the run's right neighbour. Condition 3 makes that neighbour old, so it
  is also a stopping point, and `N` lands in the same place relative to every surviving element.
  Ops already integrated are unaffected, because integration only looks at origins once.

Each replica may collect a different set of tombstones (for example, one that reloaded older
state skips a round). By the argument above, each is equivalent to never collecting, so all of
them still converge. Tests compare replicas with `liveHash()`, which hashes visible characters and
their ids, and against an oracle that replays the full history without any GC.

## Computing `S` and `C`: two rounds on the relay

The relay already learns what each replica has: from `hello`/`sync`, from `seen` (an ack each
client sends about a second after receiving ops), and from the ops a replica sends.

1. **Round 1.** When the stable vector (pointwise minimum over live members) moves past the last
   published frontier, open a round with `S = stable`. For each member, record
   `C[R] = R's own seq` once R's reported vector covers `S`. Members that join later are recorded
   when they catch up, so a newcomer blocks the round until it has seen `S`.
2. **Round 2.** When every live member is recorded and `stable ≥ C`, publish
   `collect { vv: S, requires: C }`. Each replica runs `Doc.collect`, which checks
   `requires` itself and applies the neighbour condition.

If nobody has written anything since seeing `S`, round 2 is already satisfied when round 1
opens, and the relay publishes in the same step. Without that, GC would wait for the next message.

## Membership: liveness vs. safety

A replica that never comes back would block stability forever. After a lease (default 7 days) a
disconnected replica is **evicted** and stops counting. Its authored ops still count through
`requires`, so they must be everywhere before anything is collected.

An evicted replica, or an unknown replica that shows up with offline edits after GC has started,
may hold ops that reference purged elements. The relay refuses it (close code `4410`). The client
then:

1. connects under a **new replica id** and bootstraps from the relay's collected snapshot;
2. replays its unacknowledged edits with [`rebaseUnacked`](../packages/crdt/src/rebase.ts):
   - deletes are re-applied to whatever is still visible;
   - each insert is placed after its nearest left neighbour that still exists.

Nothing typed is lost, but these edits merge by position rather than by CRDT identity.

Known limit: a replica that loses state the relay already acknowledged (for example, storage was
cleared mid-session) will reuse sequence numbers. The browser client's IndexedDB snapshot and
teardown journal are designed to make this rare. Detecting it on the relay is future work.

## How the tests pin this down

| Guarantee                       | Test                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Neighbour condition             | `gc.test.ts`: the `ONY`/`OYN` schedule; also a fixed example in `gc-property.test.ts`   |
| Two rounds (no late references) | `gc-property.test.ts`: adversarial delivery, collect before late ops arrive             |
| End to end over a lossy network | `packages/sim` fuzz: half the runs GC, every run checked against a no-GC oracle         |
| Relay + clients + persistence   | `apps/relay/test/gc.test.ts`: collection, snapshot bootstrap, eviction, rejoin, restart |
| Real browsers                   | `e2e/collab.spec.ts`: deleted text collected in three browsers                          |

Each safety condition was checked by **mutation**. Removing the neighbour condition, or
publishing after round 1 only, makes the suite fail. Random search alone almost never builds the
neighbour trap: with FIFO WebSockets through a single relay, the late insert reaches every replica
before the acknowledgement that completes the round. That is why the trap is kept as a fixed
example. In production the neighbour condition is defence in depth; in the simulator, which
reorders messages, it is required.
