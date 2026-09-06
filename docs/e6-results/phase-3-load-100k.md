# E6 Phase 3 — Load Testing (100K)

Status: COMPLETE

Phase 3 seeds the full configured dataset (100K employees), builds the k6
load-test harness in `tools/load-tests/`, and drives the API's read paths to
find where they degrade. **Validation only** — no features, no migrations, no
ADR (pure measurement, same as E3 Phase 5). Every scale problem found is
recorded here and flagged for a future phase; none is fixed in E6.

## Environment

| | |
|---|---|
| Host | Windows 11, 15.3 GB RAM, Docker Desktop 29.7.2 (Linux engine, VM capped ~7.43 GiB) |
| Postgres | `postgres:18-alpine`, container `docker-postgres-1`, `pg_stat_statements` enabled (persisted from Phase 2) |
| API / worker | `apps/api` + `apps/worker` from built `dist/`, on the host (`node dist/main.js`), DB pool `min 2 / max 10` (`drizzle.service.ts`) |
| k6 | v2.2.0 (`grafana/k6`), stock `k6 run`, no xk6 extensions |
| Timezone | host UTC+4, Postgres UTC (ADR-033) |
| **Contention** | a second, unrelated Docker stack (`ai-english-os-*`: nginx/n8n/api/postgres/redis) was running on the same engine for the whole phase and **could not be stopped from this session**. It idles at ~13% of one core. Absolute throughput numbers below are therefore a **lower bound**; the signal to read is the *scaling factor* vs the Phase 2 (10K) baseline, not the raw ceiling. |

## Seed

`npm run seed:users` (re-provisioned — ADR-035) then `npm run generate` (no
`--count`, i.e. each tenant's configured count):

```
100,000 employees + 244,855 documents = 344,855 rows in 76.1s
```

| metric | value |
|---|---|
| employees (total / seed) | 100,015 / 100,000 |
| documents (total) | 244,904 |
| tenants | 8 (3 E0 + 5 seed) |
| **database size** | **108 MB** |
| `employees` table | 42 MB  (+ `idx_employees_search` GIN 8.5 MB, `employees_tenant_id_employee_code_key` 8.5 MB) |
| `documents` table | 54 MB  (+ 4 btree indexes, 1.6–2.4 MB each) |

Per-tenant employees: Alpha 50,000 · Beta 25,000 · Gamma 15,000 · Delta 7,000
· Epsilon 3,000 · (E0 A/B/C 5 each).
Document expiry mix (all tenants): VALID 171,368 (70%) · EXPIRING_SOON 60,984
(25%) · EXPIRED 12,552 (5%) — matches config.
**Largest tenant = Alpha Corp: 50,000 employees / 122,441 documents.** All
single-client numbers below are against Alpha's token.

## Test suite with 100K seed present

`unit 90/90 · security 52/52 · integration 36/36` = **178/178**. Security
suite 86.6s (vs ~87s at 10K — no slowdown). RLS-06 / RLS-E2-02 behave exactly
as Phase 1 documented (ADR-034).

## Load-test harness (`tools/load-tests/`)

| file | purpose |
|---|---|
| `lib/workload.js` | weighted read mix + per-endpoint `Trend`s + ROPC token grant |
| `lib/fetch-tokens.ts` | `npm run loadtest:tokens` — writes `.tokens.json` for curl spot-checks |
| `scenarios/smoke.js` | `npm run loadtest:smoke` — 1 VU, every endpoint 200 |
| `scenarios/read-mix.js` | `npm run loadtest:read-mix` — `ramping-arrival-rate`, env-tunable `REQ_RATE`/`RAMP`/`HOLD`/`MAX_VUS` |

Read mix (models a compliance-dashboard session): 28% summary · 22%
document-stats · 20% expiring · 15% `employees?q=` · 12% `employees?page=` ·
3% `health/ready`. Tenant per iteration is picked weighted by employee count,
so Alpha absorbs ~50% of the load. k6 `setup()` mints one token per seed
tenant; the realm issues 300s tokens so runs are kept under 4 min.

## Single-client response times (warm, n=20, Alpha token)

| endpoint | p50 | p95 | 10K baseline p50 | factor |
|---|---|---|---|---|
| `GET /health/ready` | 4 | 9 | 5 | flat |
| `GET /api/v1/dashboard/expiring?withinDays=30` | 5 | 19 | 21 | **better** |
| `GET /api/v1/dashboard/summary` | 87 | 160 | 23 | ~3.8× |
| `GET /api/v1/dashboard/document-stats` | 125 | 175 | 25 | ~5× |
| `GET /api/v1/employees?page=N` | 120 | 150 | ~8 | ~15× |
| `GET /api/v1/employees?q=<term>` | 888 | 1000 | *(never measured — see note)* | — |

*(ms. Baseline `baseline-10k.md` measured `?search=ar`, which is not a real
parameter — the controller reads `?q=` — so that row was an unfiltered
list-page timing, not a full-text search. Phase 3 is the first real
measurement of `?q=`, and it is the worst path in the system.)*

## k6 read-mix rate sweep (15s ramp + 90s hold, MAX_VUS 80)

| target rate | actual | http_req_failed | checks | `?q=` p95 | doc-stats p95 | summary p95 | health p95 | dropped iters |
|---|---|---|---|---|---|---|---|---|
| 10/s | 8.9/s | 0.00% | 100% | 1034 | 171 | 115 | 4 | 0 |
| 20/s | 17.4/s | 0.00% | 100% | 1164 | 175 | 129 | 5 | 0 |
| 30/s | 25.9/s | 0.00% | 100% | 1190 | 183 | 139 | 10 | 0 |
| 45/s | 38.3/s | 0.00% | 100% | 2624 | 1672 | 1608 | 1011 | 64 |
| 80/s (3 min) | 40.7/s | 1.84% | 99.08% | 7057 | 5800 | 5835 | 2011 | 7075 |

*(latencies ms, end-to-end)*

**The knee is between 30 and 45 req/s on this host.** At ≤30/s everything
except `?q=` search holds firmly: 0 failures, dashboards < 200 ms p95, health
< 10 ms. At 45/s the whole API tips over at once — even the DB-cheap
`/health/ready` hits 1 s p95, which is Node **event-loop starvation** in the
single API process, not a database limit. At 80/s it is fully saturated
(4–6 s latencies, 1.8% dropped connections, 7,000+ shed iterations). Actual
throughput never exceeded ~40/s regardless of target — that is the ceiling of
this single-process / pool-10 / shared-host configuration.

Postgres CPU during the 80/s run: **~1300% (≈13 cores)**, 11–17 active
backends (API pool 10 + worker + parallel-query workers). PG memory stayed
trivial (~210 MB). The bottleneck is **CPU on O(n) scans**, not memory or I/O.

## Query plans (EXPLAIN ANALYZE, `app_user`, Alpha tenant context)

### 1. `employees?q=` — the GIN full-text index is not used  ⚠️ primary finding

```
Limit → Gather Merge → Sort(created_at)
  → Parallel Bitmap Heap Scan on employees
      Recheck: tenant_id = $A AND deleted_at IS NULL
      Filter:  to_tsvector('english', code||' '||first||' '||last||' '||dept)
               @@ plainto_tsquery('english', 'manager')
      Rows Removed by Filter: 50000
      → Bitmap Index Scan on idx_employees_active   (rows=50000)
Execution Time: ~420 ms          (× 2: the list page AND the count(*))
```

With the RLS predicate + `tenant_id` scoping in the query, the planner picks
the tenant partial-index (`idx_employees_active`), pulls **every active row
for the tenant**, and re-computes `to_tsvector(...)` per row to filter. It
never chooses `idx_employees_search` (the GIN index built for exactly this in
migration 006). Confirmed:

- `pg_stat_user_indexes.idx_scan` for `idx_employees_search` = **1** after the
  entire phase (that one is a manual EXPLAIN, not the load test).
- Forcing `enable_seqscan=off; enable_bitmapscan=off` still avoids the GIN
  index — it switches to a plain `idx_employees_tenant` scan + row filter
  (718 ms), worse.
- The GIN index *is* used (2.8 ms) when the query has **no** `tenant_id`
  predicate and a literal search term — i.e. the planner can match the index
  expression, it just costs the combined `(tsvector match) AND (tenant_id=X)`
  plan higher than the full tenant scan because the GIN index carries no
  `tenant_id` column to combine with.

Invisible at 10K because scanning 5,000 rows and recomputing the tsvector is
~30 ms. At 50K it is ~420 ms, and it is linear in the tenant's active
headcount.

**Fix (out of E6 scope — needs a migration → review gate):** a composite
`btree_gin` index on `(tenant_id, <tsvector expr>)`, or move the search
vector into a stored `tsvector` column with a plain per-tenant GIN. Flag for
**E7**.

### 2. Dashboard `summary` / `document-stats` group-bys are O(n)

```
GroupAggregate
  → Index Only Scan idx_documents_status (summary) / idx_documents_type_status (doc-stats)
      Index Cond: tenant_id = $A
      (scans ALL ~122k live doc index entries for the tenant)
summary     Execution Time: ~78 ms   (was ~5 ms at 12k docs)
doc-stats   Execution Time: ~118 ms  (parallel; slowest dashboard query)
```

Every widget load reads the whole per-tenant document index and aggregates.
Linear in the tenant's document count — projecting ~600 ms / ~1 s at 1M docs.
**Fix (out of scope):** an incrementally-maintained per-`(tenant, status)` /
per-`(tenant, doc_type, status)` rollup, refreshed where the Expiry Engine
already writes `expiry_status`. Flag for a later phase.

### 3. `employees?page=N` — 50k-row sort per page

```
Limit → Sort(created_at) [top-N heapsort, 50000 rows in]
  → Index Scan idx_employees_tenant (rows=50000)
Execution Time: ~100 ms   + count(*) ~26 ms (Index Only Scan idx_employees_active)
```

`ORDER BY created_at` is not covered by any tenant index, so every list page
sorts the tenant's whole active set. **Fix (out of scope):** a
`(tenant_id, created_at) WHERE deleted_at IS NULL` index removes the sort.

### 4. `dashboard/expiring` scales fine ✅

`Index Scan idx_documents_expiry` (`tenant_id, expiry_date`), stops at
`LIMIT 20`. O(limit), not O(n). 0.5 ms server-side, 5 ms end-to-end,
unchanged from baseline.

## Reminder scan at 100K

Manual scan enqueued onto `reminder-scans`
(`docs/runbooks/investigate-failed-notifications.md` mechanism):
**~20 s wall** for all 8 tenants. It loads **all 60,984 `EXPIRING_SOON`
documents** (every tenant) into memory and does **one `notification_log`
point-lookup per candidate** — `idx_notification_log_dedup` keeps each lookup
sub-millisecond, but it is a row-by-row loop inside a single
`concurrency: 1` transaction per tenant. At 1M documents this is a multi-minute
job holding a long read transaction per tenant. **Fix (out of scope):** batch
the dedup check (one `IN` / anti-join per tenant instead of N selects). Flag.

A first full scan of the 100K seed enqueued ~4,600 send jobs
(`notification_log` → SENT, delivered to MailHog), consistent with the
baseline's 379-at-10K, no failures.

## Operational note (no code change)

Under concurrency, every `summary` / `document-stats` / `employees?q=` query
spawns up to `max_parallel_workers_per_gather` (2) extra backends; at ~15
concurrent API queries that is ~45 Postgres processes competing for CPU,
which is what pins the host at 80/s. For this OLTP-shaped workload, lowering
`max_parallel_workers_per_gather` (or raising `min_parallel_*_scan_size`) on
the production instance is worth testing — it trades single-query latency for
concurrency headroom.

## Watch-items carried into Phase 4 (stress)

1. `employees?q=` — GIN index dead under RLS; ~420 ms × 2 per search at 50k,
   linear. **Highest-priority fix, E7.**
2. `summary` / `document-stats` — O(n) group-by; ~80 / ~120 ms at 122k docs.
3. `employees?page=` — O(n) sort; ~100 ms at 50k.
4. Reminder scan — O(EXPIRING_SOON) with per-doc round-trips; ~20 s at 61k
   candidates.
5. Single API process is the concurrency ceiling — event-loop starvation
   (health → 1 s) hits at ~45 req/s before the DB is the limiter.
6. Parallel-query fan-out multiplies CPU pressure under concurrency.

Phase 4 (300K cap — RAM floor, see `e6-scale-validation` memory) should
re-measure items 1–3 at each step and confirm they stay *linear* (not worse).

## Cleanup

Seed data left in place for Phase 4 (stress builds on 100K → 300K). Run
`npm run cleanup` to remove the full seed footprint; seed Keycloak users
persist (`npm run seed:users -- --delete` to remove). Raw k6 JSON:
`tools/load-tests/results/` (gitignored).
