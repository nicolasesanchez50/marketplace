/**
 * Deterministic volume benchmark (#118): live throughput, crash/resume
 * recovery, overlay-backfill throughput, per-method latency percentiles,
 * RSS and database growth — all at reproducible sizes, with integrity
 * failures reported as failures (exit 1), never averaged away.
 *
 *   node bench/volume.mjs [blocks] [eventsPerBlock] [collections]
 *   BENCH_CHUNK=250 BENCH_PHASES=live,recovery BENCH_OUT=... node ...
 */
import { statSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Store } from "../src/store.mjs";
import { scanOnce } from "../src/indexer.mjs";
import { SELECTORS } from "../src/decode.mjs";
import { address } from "../src/domain.mjs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BLOCKS = Number(process.argv[2] ?? 5001);
const PER_BLOCK = Number(process.argv[3] ?? 20);
const COLLECTIONS = Number(process.argv[4] ?? 3);
const CHUNK = Number(process.env.BENCH_CHUNK ?? 250);
const PHASES = (process.env.BENCH_PHASES ?? "live,overlay,recovery").split(",");
const OUT =
  process.env.BENCH_OUT ?? join(ROOT, "docs/evidence/raw/volume-default.json");
const has = (phase) => PHASES.includes(phase);

const hash = (n) => `0x${(100 + n).toString(16)}`;
const u256 = (n) => [`0x${(n & 0xffffffffffffffffn).toString(16)}`, "0x0"];
const ids = Array.from({ length: COLLECTIONS }, (_, i) =>
  address(`0x${(0xa000 + i).toString(16)}`),
);
const config = {
  chain: "BENCH",
  chainId: "0x1",
  marketplace: null,
  collections: ids.map((address) => ({ address, startBlock: 0 })),
};

const expectedEvents = (BLOCKS - 1) * PER_BLOCK;
const tokenIdFor = (n, i) => String(((n * PER_BLOCK + i) % 100000) + 1);
// Legacy flat ERC-721 Transfer: from, to, tokenId as u256 — one builder for
// both the events scan and receipts so coverage signatures match exactly.
const mkEvent = (n, i) => ({
  from_address: ids[i % COLLECTIONS],
  keys: [SELECTORS.Transfer],
  data: [
    `0x${(0x100000 + ((n * 7 + i) % 997)).toString(16)}`,
    `0x${(0x200000 + ((n * 13 + i) % 991)).toString(16)}`,
    u256(BigInt(tokenIdFor(n, i)))[0],
    "0x0",
  ],
});

const phaseStats = [];
function harness() {
  const stats = { calls: {}, failed: [], durations: {} };
  phaseStats.push(stats);
  const timed = async (method, fn) => {
    const started = performance.now();
    try {
      return await fn();
    } catch (error) {
      stats.failed.push({ method, error: String(error?.message ?? error) });
      throw error;
    } finally {
      (stats.durations[method] ??= []).push(performance.now() - started);
      stats.calls[method] = (stats.calls[method] ?? 0) + 1;
    }
  };
  return {
    stats,
    call: async (method, p) =>
      timed(method, async () => {
        if (method === "starknet_chainId") return "0x1";
        if (method === "starknet_getClassHashAt") return "0x0def1";
        if (method === "starknet_getClass") return { abi: [] };
        if (method === "starknet_getEvents") {
          const lo = p.filter.from_block.block_number,
            hi = p.filter.to_block.block_number;
          const events = [];
          for (let n = Math.max(lo, 1); n <= Math.min(hi, BLOCKS - 1); n++)
            for (let i = 0; i < PER_BLOCK; i++)
              events.push({
                ...mkEvent(n, i),
                block_number: n,
                block_hash: hash(n),
                transaction_hash: `0x${(n * 100).toString(16)}`,
              });
          return { events };
        }
        const n =
          p.block_id === "latest" ? BLOCKS - 1 : Number(p.block_id.block_number);
        const block = {
          block_number: n,
          block_hash: hash(n),
          parent_hash: n === 0 ? "0x0" : hash(n - 1),
          timestamp: 100 + n,
          status: "ACCEPTED_ON_L2",
          transactions: [],
        };
        if (method === "starknet_getBlockWithReceipts" && n >= 1 && n < BLOCKS)
          block.transactions = [
            {
              receipt: {
                transaction_hash: `0x${(n * 100).toString(16)}`,
                execution_status: "SUCCEEDED",
                events: Array.from({ length: PER_BLOCK }, (_, i) => mkEvent(n, i)),
              },
            },
          ];
        return block;
      }),
  };
}

const percentile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(3),
  );
};
const dirSize = (path) => {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"])
    try {
      bytes += statSync(path + suffix).size;
    } catch {}
  return bytes;
};
const rssMb = () => Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));

async function runChunks(store, rpc, { until = BLOCKS, label }) {
  const chunks = [];
  let peakRss = rssMb();
  for (;;) {
    const head = await store.head(),
      from = head ? head.number + 1 : 0;
    if (from >= until) break;
    const stop = Math.min(from + CHUNK, until) - 1,
      t0 = performance.now();
    await scanOnce(store, rpc, config, {
      window: stop - from + 1,
      stopAt: stop,
    });
    const ms = performance.now() - t0;
    peakRss = Math.max(peakRss, rssMb());
    chunks.push({ from, to: stop, ms: Number(ms.toFixed(1)) });
  }
  return { chunks, peakRss, label };
}
const chunkStats = (chunks) => ({
  p50: percentile(chunks.map((c) => c.ms), 0.5),
  p95: percentile(chunks.map((c) => c.ms), 0.95),
  max: Number(Math.max(...chunks.map((c) => c.ms)).toFixed(1)),
});
const rmDb = (path) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
};

const tmp = join(process.env.TMPDIR ?? "/tmp", `bench-volume-${process.pid}.sqlite`);
mkdirSync(dirname(OUT), { recursive: true });
const failures = [];
const report = {
  benchmark: "epic-108 volume",
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    note: "Deterministic synthetic chain, local fake RPC, warm filesystem cache; network and real-RPC latency excluded by construction.",
  },
  config: {
    blocks: BLOCKS,
    eventsPerBlock: PER_BLOCK,
    collections: COLLECTIONS,
    chunk: CHUNK,
    phases: PHASES,
  },
};

// ---- live index (full rebuild from empty) ----
let store = new Store(tmp);
let rpc = harness();
const beforeBytes = dirSize(tmp);
let t0 = performance.now();
const live = has("live") ? await runChunks(store, rpc, { label: "live" }) : null;
const liveWall = Math.max(performance.now() - t0, 0.001);
const eventsAfter = store.list("activity").length;
const afterBytes = dirSize(tmp);
if (has("live") && eventsAfter !== expectedEvents)
  failures.push(`live integrity: ${eventsAfter} !== ${expectedEvents} events`);
if (rpc.stats.failed.length)
  failures.push(
    `live rpc failures: ${rpc.stats.failed
      .slice(0, 3)
      .map((f) => f.method + ":" + f.error)
      .join("; ")}`,
  );
const classCallsLive = rpc.stats.calls.starknet_getClass ?? 0;
report.live = live
  ? {
      wallMs: Number(liveWall.toFixed(1)),
      blocksPerSecond: Number(((BLOCKS / liveWall) * 1000).toFixed(1)),
      eventsPerSecond: Number(((expectedEvents / liveWall) * 1000).toFixed(1)),
      peakRssMb: live.peakRss,
      chunkMs: chunkStats(live.chunks),
      dbBytesAfter: afterBytes,
      dbBytesPerEvent: Number(((afterBytes - beforeBytes) / expectedEvents).toFixed(1)),
      dbBytesPerBlock: Number(((afterBytes - beforeBytes) / BLOCKS).toFixed(1)),
      rpcCalls: rpc.stats.calls,
      failedCalls: rpc.stats.failed.length,
    }
  : "skipped";

// ---- overlay re-scan (#113 backfill writer over a populated database) ----
store.close();
rpc = harness();
store = new Store(tmp);
if (has("overlay")) {
  t0 = performance.now();
  for (let start = 0; start < BLOCKS; start += CHUNK) {
    const stop = Math.min(start + CHUNK, BLOCKS) - 1;
    await scanOnce(store, rpc, config, {
      scope: [ids[0]],
      from: start,
      stopAt: stop,
      window: stop - start + 1,
    });
  }
  const overlayWall = performance.now() - t0;
  const overlayEvents = store.list("activity").length;
  if (overlayEvents !== expectedEvents)
    failures.push(`overlay integrity: ${overlayEvents} !== ${expectedEvents} events`);
  if (rpc.stats.failed.length) failures.push("overlay rpc failures");
  report.overlayRescan = {
    wallMs: Number(overlayWall.toFixed(1)),
    blocksPerSecond: Number(((BLOCKS / overlayWall) * 1000).toFixed(1)),
    peakRssMb: rssMb(),
    classCalls: rpc.stats.calls.starknet_getClass ?? 0,
    classCallsFirstPass: classCallsLive,
    classCallReduction:
      classCallsLive > 0
        ? `${Math.round(
            100 -
              ((rpc.stats.calls.starknet_getClass ?? 0) / classCallsLive) * 100,
          )}% (class ABI cache)`
        : "n/a",
    failedCalls: rpc.stats.failed.length,
  };
} else report.overlayRescan = "skipped";
store.close();

// ---- crash + resume recovery ----
rmDb(tmp);
if (has("recovery")) {
  store = new Store(tmp);
  rpc = harness();
  const crashAt = Math.floor(BLOCKS / 2);
  t0 = performance.now();
  await runChunks(store, rpc, { until: crashAt, label: "before-crash" });
  const crashWall = performance.now() - t0;
  store.close(); // simulated crash: stop at a block boundary
  const t1 = performance.now();
  store = new Store(tmp);
  const resumeRpc = harness();
  await runChunks(store, resumeRpc, { until: BLOCKS, label: "recovery" });
  const resumeWall = performance.now() - t1;
  const recoveredEvents = store.list("activity").length;
  if (recoveredEvents !== expectedEvents)
    failures.push(`recovery integrity: ${recoveredEvents} !== ${expectedEvents} events`);
  if (resumeRpc.stats.failed.length) failures.push("recovery rpc failures");
  report.recovery = {
    crashedAfterMs: Number(crashWall.toFixed(1)),
    crashedAtBlock: crashAt,
    resumeWallMs: Number(resumeWall.toFixed(1)),
    resumeBlocksPerSecond: Number(
      (((BLOCKS - crashAt) / resumeWall) * 1000).toFixed(1),
    ),
    peakRssMb: rssMb(),
    recoveredEvents,
    expectedEvents,
    failedCalls: resumeRpc.stats.failed.length,
  };
  store.close();
} else report.recovery = "skipped";

// ---- latency percentiles per method (all phases; local synthetic RPC) ----
const merged = {};
for (const stats of phaseStats)
  for (const [method, values] of Object.entries(stats.durations))
    (merged[method] ??= []).push(...values);
report.latencyMs = Object.fromEntries(
  Object.entries(merged).map(([method, values]) => [
    method,
    {
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
      count: values.length,
    },
  ]),
);
report.failedRpcCalls = phaseStats.reduce((n, stats) => n + stats.failed.length, 0);
report.failures = failures;
rmDb(tmp);

writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(
  [
    `live:      ${report.live === "skipped" ? "skipped" : `${report.live.blocksPerSecond} blocks/s, ${report.live.eventsPerSecond} events/s, peak RSS ${report.live.peakRssMb} MB`}`,
    `overlay:   ${typeof report.overlayRescan === "string" ? report.overlayRescan : `${report.overlayRescan.blocksPerSecond} blocks/s (backfill writer over indexed blocks), ${report.overlayRescan.classCallReduction}`}`,
    `recovery:  ${typeof report.recovery === "string" ? report.recovery : `resume ${report.recovery.resumeBlocksPerSecond} blocks/s after crash at block ${report.recovery.crashedAtBlock} (${report.recovery.resumeWallMs} ms)`}`,
    `db growth: ${report.live === "skipped" ? "skipped" : `${report.live.dbBytesPerEvent} B/event, ${report.live.dbBytesPerBlock} B/block`}`,
    `latency:   getEvents p95 ${report.latencyMs.starknet_getEvents?.p95 ?? "-"} ms, receipts p95 ${report.latencyMs.starknet_getBlockWithReceipts?.p95 ?? "-"} ms (local synthetic RPC)`,
    `failures:  ${failures.length ? failures.join(" | ") : "none"}`,
    `raw:       ${OUT}`,
  ].join("\n"),
);
if (failures.length) process.exit(1);
