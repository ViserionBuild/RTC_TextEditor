/**
 * CollabPad benchmarks (M-1..M-5 in PRD/01-requirements-analysis.md).
 *
 *   pnpm bench            → bench/results/results.json + a console summary
 *
 * Uses the automerge-paper editing trace (259,778 single-character edits, one author):
 *   pnpm bench:fetch      downloads it to bench/data/
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Doc, type Op } from '@collabpad/crdt';
import { encode, encodeOps, encodeOpsFrame } from '@collabpad/protocol';
import { NaiveRga } from './naive-rga';
import { loadTrace, type Trace } from './trace';

const here = (p: string) => new URL(p, import.meta.url).pathname;
const trace = loadTrace(here('../data/automerge-paper.json.gz'));
const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const heapMB = () => {
  gc();
  return process.memoryUsage().heapUsed / 2 ** 20;
};
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

function replay(doc: Doc, patches: Trace['patches'], onPatch?: (i: number) => void): void {
  patches.forEach(([pos, del, ins], i) => {
    if (del) doc.deleteRange(pos, del);
    if (ins) doc.insertAt(pos, ins);
    onPatch?.(i + 1);
  });
}

// ---------- M-5: local editing speed + M-3 growth samples ----------

const heapBefore = heapMB();
const author = new Doc('author');
const latencies: number[] = [];
const growth: {
  ops: number;
  visible: number;
  tombstones: number;
  items: number;
  snapshotBytes: number;
  heapMB: number;
}[] = [];
const SAMPLE_EVERY = 10_000;
let t = performance.now();
const start = t;
replay(author, trace.patches, (i) => {
  const now = performance.now();
  latencies.push(now - t);
  if (i % SAMPLE_EVERY === 0 || i === trace.patches.length) {
    const s = author.stats();
    growth.push({
      ops: i,
      visible: s.visible,
      tombstones: s.tombstones,
      items: s.items,
      snapshotBytes: utf8(JSON.stringify({ ...author.snapshot(), log: [] })),
      heapMB: heapMB() - heapBefore,
    });
  }
  t = performance.now();
});
const localMs = performance.now() - start - 0; // includes sampling overhead
if (author.text() !== trace.endContent) throw new Error('replay produced the wrong text');
latencies.sort((a, b) => a - b);
const allOps: Op[] = author.opsSince({});

// Time without sampling overhead.
const clean = new Doc('author');
const t0 = performance.now();
replay(clean, trace.patches);
const localCleanMs = performance.now() - t0;

// ---------- M-5: remote integration (another replica receiving every op) ----------

const remote = new Doc('reader');
const t1 = performance.now();
for (const op of allOps) remote.applyRemote([op]);
const remoteOneByOneMs = performance.now() - t1;
const batch = new Doc('reader2');
const t2 = performance.now();
batch.applyRemote(allOps);
const remoteBatchMs = performance.now() - t2;
if (remote.text() !== trace.endContent || batch.text() !== trace.endContent)
  throw new Error('remote mismatch');

// ---------- Naive per-character RGA on prefixes (shows the O(n) per op cost) ----------

const naivePrefix: { ops: number; naiveMs: number; runLengthMs: number }[] = [];
for (const n of [10_000, 20_000, 40_000, 80_000, 160_000, allOps.length]) {
  const ops = allOps.slice(0, n);
  const naive = new NaiveRga();
  const ta = performance.now();
  for (const op of ops) {
    if (op.type === 'ins') naive.integrateInsert(op);
    else naive.integrateDelete(op);
  }
  const naiveMs = performance.now() - ta;
  const fast = new Doc('x');
  const tb = performance.now();
  fast.applyRemote(ops);
  naivePrefix.push({ ops: n, naiveMs, runLengthMs: performance.now() - tb });
}

// ---------- M-1: bytes on the wire ----------

let liveJson = 0;
let liveBinary = 0;
for (const op of allOps) {
  liveJson += utf8(encode({ kind: 'ops', ops: [op] }));
  liveBinary += encodeOpsFrame([op]).length;
}
const historyJson = utf8(encode({ kind: 'ops', ops: allOps }));
const historyBinary = encodeOps(allOps).length;
const snapshotJson = utf8(JSON.stringify({ ...author.snapshot(), log: [] }));

// ---------- M-4: garbage collection ----------

const before = author.stats();
const collected = Doc.load('gc', author.snapshot());
const everything = collected.versionVector();
const removed = collected.collect({ vv: everything, requires: everything });
const after = collected.stats();
const snapshotAfterGc = utf8(JSON.stringify({ ...collected.snapshot(), log: [] }));
if (collected.text() !== trace.endContent) throw new Error('GC changed the text');

// ---------- M-3: memory held by one replica ----------

/** Heap retained by whatever `build` returns, after a full GC. */
function retainedMB(build: () => unknown): number {
  const base = heapMB();
  const keep = build();
  const used = heapMB() - base;
  void keep;
  return used;
}
const memory = {
  withLogMB: retainedMB(() => {
    const d = new Doc('author');
    replay(d, trace.patches);
    return d;
  }),
  collectedMB: retainedMB(() => {
    const d = new Doc('author');
    replay(d, trace.patches);
    const vv = d.versionVector();
    d.collect({ vv, requires: vv });
    return d;
  }),
  textOnlyMB: retainedMB(() => trace.endContent.split('').join('')),
};

// ---------- M-2: reconnect cost after N offline edits ----------

const reconnect: {
  offlineEdits: number;
  deltaBinary: number;
  deltaJson: number;
  fullSnapshot: number;
}[] = [];
for (const n of [10, 100, 1_000, 10_000]) {
  const shared = trace.patches.length - n;
  const a = new Doc('author');
  replay(a, trace.patches.slice(0, shared));
  const vvAtDisconnect = a.versionVector();
  replay(a, trace.patches.slice(shared));
  const missing = a.opsSince(vvAtDisconnect);
  const hello = utf8(encode({ kind: 'hello', replica: 'b', vv: vvAtDisconnect }));
  const sync = utf8(encode({ kind: 'sync', vv: a.versionVector() }));
  reconnect.push({
    offlineEdits: n,
    deltaBinary: hello + sync + encodeOpsFrame(missing).length,
    deltaJson: hello + sync + utf8(encode({ kind: 'ops', ops: missing })),
    fullSnapshot: utf8(JSON.stringify({ ...a.snapshot(), log: [] })),
  });
}

// ---------- report ----------

const results = {
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    date: new Date().toISOString(),
  },
  trace: {
    name: 'automerge-paper',
    patches: trace.patches.length,
    finalChars: trace.endContent.length,
    ops: allOps.length,
  },
  local: {
    totalMs: localCleanMs,
    opsPerSec: allOps.length / (localCleanMs / 1000),
    p50us: pct(latencies, 0.5) * 1000,
    p99us: pct(latencies, 0.99) * 1000,
    maxMs: latencies.at(-1)!,
    sampledRunMs: localMs,
  },
  remote: { oneByOneMs: remoteOneByOneMs, batchMs: remoteBatchMs },
  naivePrefix,
  wire: {
    liveJson,
    liveBinary,
    liveJsonPerOp: liveJson / allOps.length,
    liveBinaryPerOp: liveBinary / allOps.length,
    historyJson,
    historyBinary,
    historyJsonGzip: gzipSync(encode({ kind: 'ops', ops: allOps })).length,
    historyBinaryGzip: gzipSync(encodeOps(allOps)).length,
    snapshotJson,
    snapshotJsonGzip: gzipSync(JSON.stringify({ ...author.snapshot(), log: [] })).length,
  },
  gc: {
    before,
    after,
    removed,
    snapshotBefore: snapshotJson,
    snapshotAfter: snapshotAfterGc,
  },
  reconnect,
  memory,
  growth,
};

mkdirSync(here('../results'), { recursive: true });
writeFileSync(here('../results/results.json'), JSON.stringify(results, null, 2));

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 2 ** 20).toFixed(2)} MB`;
console.log(`
trace          ${results.trace.patches.toLocaleString('en-US')} edits → ${results.trace.finalChars.toLocaleString('en-US')} chars
local replay   ${localCleanMs.toFixed(0)} ms  (${Math.round(results.local.opsPerSec).toLocaleString('en-US')} ops/s, p50 ${results.local.p50us.toFixed(1)} µs, p99 ${results.local.p99us.toFixed(1)} µs)
remote replay  ${remoteOneByOneMs.toFixed(0)} ms one op at a time, ${remoteBatchMs.toFixed(0)} ms as one batch
naive RGA      ${naivePrefix.map((p) => `${p.ops / 1000}k: ${p.naiveMs.toFixed(0)} ms vs ${p.runLengthMs.toFixed(0)} ms`).join(' | ')}
live bytes/op  JSON ${results.wire.liveJsonPerOp.toFixed(1)} B, binary ${results.wire.liveBinaryPerOp.toFixed(1)} B
full history   JSON ${mb(historyJson)}, binary ${mb(historyBinary)} (gzip: ${mb(results.wire.historyJsonGzip)} / ${mb(results.wire.historyBinaryGzip)})
snapshot       ${kb(snapshotJson)} with tombstones, ${kb(snapshotAfterGc)} after GC (${removed.toLocaleString('en-US')} tombstones removed)
runs           ${before.items.toLocaleString('en-US')} before GC, ${after.items.toLocaleString('en-US')} after (${(before.elements / before.items).toFixed(1)} chars/run)
reconnect      ${reconnect.map((r) => `${r.offlineEdits} edits: ${kb(r.deltaBinary)} vs snapshot ${kb(r.fullSnapshot)}`).join(' | ')}
memory         ${memory.withLogMB.toFixed(1)} MB with the op log, ${memory.collectedMB.toFixed(1)} MB after GC (text alone ${memory.textOnlyMB.toFixed(1)} MB)
`);
