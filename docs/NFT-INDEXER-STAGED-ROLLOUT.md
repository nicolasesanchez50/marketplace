# NFT indexer: coverage semantics, capacity evidence, runbooks and staged rollout

Epic #108 sub-issue #118. This document covers chain-wide NFT indexing
(discovery, classification, decoding, backfill, metadata) from an operator's
point of view: what the coverage report means, what the measured capacity
evidence says, how to recover from each failure class, and how to roll the
feature out without touching the live marketplace.

Nothing here enables a collection for trading. Activation stays an explicit
administrator action through the reviewed registry and the release procedure in
[OPERATIONS](OPERATIONS.md).

## Coverage semantics

`GET /operator/coverage` (gated by the operator token, same gate as every
`/operator` route) returns one entry per chain record plus the registered
collections that have no chain record yet.

- `counts` — records per `state`. A state is set by the classifier
  (`src/classify.mjs`), never inferred downstream.
- `unsupported` — records the classifier rejected, each carrying the `reason`
  it recorded (for example a fungible-isolation reason). Unsupported records are
  never indexed and never traded; they stay visible so "nothing happened" is
  distinguishable from "nothing was discovered".
- `quarantined` — collections whose events could not be resolved with the ABI
  context pinned at the scan anchor (`UNKNOWN_COLLECTION_EVENT`). Each entry
  carries the observation count and the last error, and the collection is
  parked in state `failed`. A quarantined collection never has invented state:
  decoding stops for it until a human supplies the missing ABI, and the raw
  events stay in `chain.events` (`type: "undecodable"` with `decodeError`) so
  the range is replayable once the adapter exists.
- `gaps` — recorded history gaps (for example a probe floor found by the
  discovery walk). A gap is an honest statement of what was never read; it is
  not an error and it does not fail a build.
- `notIndexed` — collections present in the configuration with no progress
  row yet, each with the `startBlock` that must be covered before they can be
  considered indexed.
- `records` — the full list; `standard`, `method` and the classification
  evidence carry the decoder provenance (`record.decoderVersion`, currently
  `nft-events.v2`) so a decoded collection can be traced to the adapter
  (`nft-flat.v2` / `nft-enum.v2` / `nft-members.v2`) that produced it.

Read the report as: discovered != classified != indexed. Search exposes
chain-discovered collections labelled `basis: "chain"`; holdings and tokens
labelled `basis: "indexed"` are the only ones backed by a completed scan.

## Capacity evidence

Measured with `pnpm backend:bench:volume`
(`services/marketplace-backend/bench/volume.mjs`), a deterministic synthetic
chain served by a local fake RPC. Raw output:
[`docs/evidence/raw/volume-2026-10-10.json`](evidence/raw/volume-2026-10-10.json).

Configuration: 1,001 blocks × 20 events/block × 3 collections = 20,020 events,
250-block commit chunks, warm filesystem cache.

The same benchmark at 1,000,100 events
([`docs/evidence/raw/volume-1m.json`](evidence/raw/volume-1m.json): 10,001
blocks × 100 events/block × 3 collections) confirms the shape at scale: live
5.2 blocks/s / 524.1 events/s at 441.3 MB peak RSS (3,475 B/event, 3.47 GB
database), overlay re-scan 134.2 blocks/s with 100% class-ABI-call reduction,
and a crash at block 5,000 resumed to 1,000,000/1,000,000 events with 0 failed
RPC calls. Peak RSS on the overlay and resume passes reached 2.7–2.8 GB, so
size the staging container for ~3 GB before raising `blocks` past 10k.

| Phase | Result |
| --- | --- |
| Live indexing (full rebuild from empty) | 14.7 blocks/s, 293.2 events/s, peak RSS 285.3 MB, 68.2 s wall |
| Overlay re-scan (#113 backfill writer over a populated database) | 685.8 blocks/s, 0 `starknet_getClass` calls (100% class-ABI-cache reduction vs the live pass) |
| Crash + resume (stop at block 500, reopen the database) | resume 15.8 blocks/s, 20,000/20,000 events present, 0 failed RPC calls |
| Database growth | 4,760 B/event, 95,112 B/block (95 MB for the run) |
| Latency (local synthetic RPC) | `starknet_getEvents` p95 107.2 ms per 250-block window, `starknet_getBlockWithReceipts` p95 0.25 ms |

The benchmark exits 1 if any event count mismatches or any RPC call fails, so a
green run is an integrity statement, not an average.

**Honest limits.** The RPC here is in-process and free of network latency and
provider quota, so these numbers are an upper bound on the code path, not a
forecast for a real provider. Re-measure against the actual RPC before
committing to a rollout window, and treat the numbers below as the shape of the
target, not as signed-off service levels.

### Provider budgets

Budgets are enforced in code (`src/indexer-options.mjs`), not by convention:

- `MARKETPLACE_INDEX_WINDOW_EVENT_BUDGET` (default 50,000) — a single
  `starknet_getEvents` window that would return more events than this is split
  instead of being fetched whole.
- `MARKETPLACE_INDEX_EMITTER_BUDGET` (default 500) — unknown emitters found in
  a window beyond this count become bounded discovery candidates instead of
  being followed immediately.
- `MARKETPLACE_INDEX_WINDOW` (default 1,000 blocks), `MARKETPLACE_INDEX_CONCURRENCY`
  (default 8), `MARKETPLACE_INDEX_RPC_BATCH` (default 1), `MARKETPLACE_INDEX_COMMIT_BATCH`
  (default 250).
- Discovery: `MARKETPLACE_DISCOVERY_SPAN` (default 100 blocks per pass),
  `MARKETPLACE_DISCOVERY_CONCURRENCY` (default 4),
  `MARKETPLACE_DISCOVERY_EMITTER_BUDGET` (default 2,000),
  `MARKETPLACE_DISCOVERY_PROBES` (default 6 history probes),
  `MARKETPLACE_DISCOVERY_MAX_REWIND` (default 100 blocks).
- Metadata: the refresh quota is per collection (`ceil(limit / 2)` by default),
  so one busy collection cannot exhaust the queue.

Measured request shape per 250-block window: one unfiltered `getEvents`, one
`getBlockWithReceipts` per block, `getClassHashAt` per newly seen collection and
one `getClass` for the whole run — the class ABI is cached in
`chain.class_evidence`, which is why the overlay pass spends zero class calls.

Provisional targets derived from this run, to be confirmed against a real
provider before rollout: sustained ≥5 blocks/s per worker at 20 events/block,
worker RSS < 1 GB at 3 collections, database growth < 100 KB/block, and zero
failed RPC calls per completed window.

## Failure and recovery runbooks

### Process crash or restart

Chain-derived state is checkpointed per block. Restarting the worker resumes
from the stored head; nothing is re-fetched before it. Measured: after a hard
stop at block 500 of 1,001 the reopened database resumed at 15.8 blocks/s and
finished with all 20,000 events and no failed calls. No manual step is needed.

### Reorg

`store.rewind(target)` undoes every height above the target (including
discovery, classification and backfill writes that ride a checkpoint height)
and bumps the store generation. `chain.class_evidence` carries no heights and
survives; anything keyed to a block does not. After a rewind the next scan
re-walks the affected range and re-derives classification from the surviving
evidence.

### Provider outage or rate limit

Bounded windows and budgets mean a slow or failing provider degrades throughput
rather than memory. A discovery pass that finds its stored checkpoint hash no
longer matches the chain re-walks to the common ancestor within
`MARKETPLACE_DISCOVERY_MAX_REWIND`; beyond that it stops and reports instead of
rewriting history. Failed classification probes keep the record's state and
retry up to three times. Treat sustained `worker_error` events with a rising
head distance as an outage, not as data loss.

### Quarantine

A collection event that cannot be resolved against the ABI pinned at the scan
anchor raises `UNKNOWN_COLLECTION_EVENT`; `prepareBlock` quarantines the
collection and `recordQuarantine` writes the observation count, first/last
observation and the last error, with the collection in state `failed`. Raw
events remain in `chain.events` as `undecodable`. To clear it: supply the
missing ABI context (or an adapter), then re-scan the affected range — the raw
rows make the replay exact. Do not clear a quarantine by hand.

### Restore and replay

Chain-derived state is rebuildable from the chain; application and media state
are the durable parts and are protected separately. Independent backfills
(#113) fill holes in place: jobs pin a canonical target anchor, advance a
monotonic cursor, re-validate the anchor on disk and on chain at promotion, and
refuse overlapping jobs. Overlay delivery is idempotent — activity rows double
as the per-event replay marker, so a duplicate delivery changes no count
(regression-tested in `legacy-coverage.test.mjs`).

## Staged rollout

1. **Shadow.** Run discovery + indexing + classification against the production
   RPC with the production database read-only. Compare the coverage report and
   the collection catalog against the existing indexer's view; Realms trading
   and source freshness must be unchanged. Budget one bounded discovery span per
   pass (`MARKETPLACE_DISCOVERY_SPAN`) so the shadow run cannot dominate the
   provider quota.
2. **Staging.** Enable the workers (`backend:discover`, `backend:index`,
   `backend:metadata`) on the staging topology from
   [POSTGRES-OPERATIONS](POSTGRES-OPERATIONS.md), one leased indexing worker and
   one metadata worker, API replicas on independent pools. Re-run the volume
   benchmark there to replace the synthetic-provider numbers above with measured
   ones, and record them against the commit.
3. **Production.** Follow the existing release procedure in
   [OPERATIONS](OPERATIONS.md) and [MAINNET-DEPLOYMENT](MAINNET-DEPLOYMENT.md):
   release gates, recorded commit, operator authorization, reviewed registry.
   Enabling a discovered collection for trading remains an explicit
   administrator transaction — nothing in the indexer, the classifier or the
   coverage report can enable trading on its own.

Rollback at any stage is the rewind/restore path above plus returning the
worker configuration to its previous value; no contract state is involved.

## Alerts worth wiring

- `index_progress` / `discover_progress` stall: head distance grows while the
  worker keeps reporting.
- `index_error` / `discover_error` repeats for the same cause.
- Coverage report drift: a growing `quarantined` or `unsupported` list, or a
  `notIndexed` entry that stays present after its `startBlock` has passed.
- RSS or database growth beyond the provisional targets above.

## Evidence index

- [`evidence/raw/volume-2026-10-10.json`](evidence/raw/volume-2026-10-10.json) —
  volume, overlay and crash/resume benchmark (this document's numbers).
- [`evidence/raw/volume-1m.json`](evidence/raw/volume-1m.json) — the same
  benchmark at 1,000,100 events: capacity ceiling, database bytes/event and a
  crash/resume integrity check (1,000,000/1,000,000 events, 0 failed RPC calls).
- `pnpm backend:test` / `pnpm backend:pg:test` — the regression suites the
  coverage, adapter, backfill and ERC-1155 behaviour is pinned by.
