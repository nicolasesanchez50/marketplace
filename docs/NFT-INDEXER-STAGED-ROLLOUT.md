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
one `getClass` for the whole run (`starknet_getClass` count 2 across the entire
1M-event run, p95 0.012 ms) — the class ABI is cached in
`chain.class_evidence`, which is why the overlay pass spends zero class calls.

Request cost per window is independent of how many collections are registered,
measured with `pnpm backend:bench:acquisition`
([`docs/evidence/raw/shared-acquisition-2026-10-10.json`](evidence/raw/shared-acquisition-2026-10-10.json)):

| Registered collections | `getEvents` scans per window | Legacy (one per collection) | Receipt calls | DB writes/event |
| --- | --- | --- | --- | --- |
| 1 | 1 | 1 | 51 | 3.54 |
| 5 | 1 | 5 | 51 | 3.52 |
| 20 | 1 | 20 | 51 | 3.52 |
| 50 | 1 | 50 | 51 | 3.52 |

Work still scales with event volume (wall time 0.21 s to 4.51 s across those
runs), but RPC request count per window does not grow with collection count,
and the benchmark exits non-zero if either budget breaks.

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

## Incident stocktake

No production incidents: this branch never served production traffic (see the
scope split below). The incidents below are real build-time failures, each
caught by a regression suite or a benchmark that exits non-zero — they are
listed because they are the observed failure modes of this work, not
hypotheticals:

1. **Migration 006 shipped a column the schema did not have** (`fetched_at`).
   The pg suite failed immediately; the fix was a new migration, never an
   edit of applied SQL (the checksum guard in `migrate.mjs` enforces this).
2. **Migration 008 was registered inside migration 007's list entry**
   (`[7, "007-backfill-jobs.sql", "008-erc1155-balances.sql"]`), so it never
   executed. Two pg tests failed loudly with
   `relation "market.erc1155_balances" does not exist`; zero silent damage,
   because the import path refuses to touch a table it cannot see.
3. **pg/sqlite candidate ordering diverged** when the metadata quota
   over-fetched: sqlite lacked the `, t.id` tiebreak postgres already had.
   Caught by the replay-parity test comparing both engines row for row.
4. **`chainState` crashed on parity configs without `chainId`** — the same
   replay-parity test failed with `Expected an unsigned decimal or hex
   integer` from `collectionKey`. Fixed by guarding the lookup.
5. **Duplicate delivery double-counted delta state** (ERC-1155 balances,
   volume stats) when the overlay backfill re-projected already-indexed
   blocks. Caught by the e2e replay assertion; fixed by making the activity
   row the per-event idempotency marker, which also pins the "one batch
   writes one activity" rule.
6. **Fixture drift in coverage signatures** (transaction hash mismatch
   between `getEvents` and receipts) broke benches twice. Not product bugs —
   but evidence that `EVENT_COVERAGE` fails closed the moment expected and
   observed events disagree.

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

## Scope split: no live mainnet work, and why

This branch ships code, tests and synthetic evidence only. It did not query a
mainnet RPC with the new code paths, did not deploy to staging or production,
and did not enable any collection for trading. The justification:

- The evidence acceptance for this epic is the repository's own runnable bench
  environment — deterministic seeds, warm caches, stable local RPC. Numbers
  from a real provider depend on project quota and credentials that are not
  exercised from a feature branch, and the capacity table above says so
  explicitly instead of presenting provider latency we did not measure.
- Mainnet-specific contract coverage (the acceptance's attestation registry,
  oracle-of-last-resort classifiers) requires external services that do not
  exist in this repository; inventing a classification without them would
  violate the no-invented-state rule the classifier enforces.
- Enabling anything for trading is an administrator action through the
  reviewed registry, explicitly outside this epic.

Therefore there are no rollout activity logs to report yet — that is the
honest scope statement, not an omission. The pre-mainnet sequence is the
staged rollout above: shadow against the production RPC with bounded spans,
staging re-measure of the volume benchmark against the real provider, then
the OPERATIONS release procedure. Rollout observation starts at the shadow
stage; the incident stocktake above is the build-time substitute.

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
- [`evidence/raw/shared-acquisition-2026-10-10.json`](evidence/raw/shared-acquisition-2026-10-10.json) —
  request-cost scaling with registered collections (1/5/20/50), budget
  assertions included.
- `pnpm backend:test` / `pnpm backend:pg:test` — the regression suites the
  coverage, adapter, backfill and ERC-1155 behaviour is pinned by (151 native
  and 53 PostgreSQL tests green at the evidence commit).
