# E6 Performance Report — Production Simulation & Scale Validation

Consolidates Phases 2–5. E6 added **no features and no migrations** — it
seeded the system at 10×–50× its prior test scale, drove it with k6, injected
real infrastructure failures, and ran a backup/restore drill. Everything below
is measured, not modelled.

---

## 1. Executive summary

- **Correctness holds at every scale.** 178/178 tests pass with a 300K-employee
  seed loaded; RLS isolation, the append-only audit trail, and optimistic
  locking all behave identically to the 15-row E0 fixture.
- **Performance degrades linearly, predictably** — never worse-than-linear —
  but the system's *serving capacity per unit of data is low*: five hot read
  paths are `O(n)` in tenant-owned row counts, so sustainable throughput
  scales as roughly `1/n` (≈30 req/s at 100K employees → ≈10 req/s at 300K on
  the validation host).
- **Two read paths stay flat with scale**: `GET /dashboard/expiring`
  (`O(limit)` — index range scan + `LIMIT`) and `GET /health*` (`O(1)`).
- **Resilience is uneven.** The system self-heals cleanly from Redis,
  Keycloak, SMTP, and worker-crash failures. It does **not** survive a
  Postgres connection reset — the `pg` pool has no error handler, so a
  Postgres restart *or a single `pg_terminate_backend` on an idle connection*
  crashes both the API and the worker. In production the container restart
  policy masks this as a hard restart.
- **Backup/restore works** and preserves every security property — verified by
  restoring a dump and confirming RLS still enforces and `audit_events` still
  rejects `UPDATE`/`DELETE`.
- **Nothing found is a gate blocker.** Everything actionable is index/rollup
  work or a one-line pool fix, itemised for **E7** in §8.

---

## 2. Environment & method

| | |
|---|---|
| Host | Windows 11, 15.3 GB RAM, Docker Desktop 29.7.2 (Linux VM capped ~7.43 GiB) |
| Stack | `postgres:18-alpine`, `redis:7`, `keycloak:26.7.2`, `mailhog`; `apps/api` + `apps/worker` from built `dist/` on the host; DB pool `min 2 / max 10` per process |
| Load tool | k6 v2.2.0, stock `k6 run`, `tools/load-tests/` (weighted read-mix, `ramping-arrival-rate`) |
| Seed tool | `tools/seed/` — `@faker-js/faker`, `@test.invalid` emails, batched multi-row `INSERT` under RLS, one txn per tenant |
| **Caveats** | (a) A second, unrelated Docker stack (`ai-english-os-*`) ran on the same engine throughout and **could not be stopped** — absolute throughput numbers are a *lower bound*; the **scaling factors** are the signal. (b) Host RAM was below the 8 GB working floor for the whole epoch, capping the sustained-load phase at 300K (500K is seed + EXPLAIN + smoke only; 1M deferred). (c) The dev host cannot send a real POSIX SIGTERM, so graceful-shutdown drain itself was verified in E5, not re-run here. |

Per-tenant seed weighting (constant across sizes): Alpha 50% · Beta 25% ·
Gamma 15% · Delta 7% · Epsilon 3%. All single-client numbers are against
**Alpha**, the largest tenant.

---

## 3. Dataset scaling

| seed (`--count`) | employees | documents | DB size | generate time | Alpha (emp / docs) |
|---|---|---|---|---|---|
| 10K (baseline) | 10,015 | 24,567 | 21 MB | 7.5 s | 5,000 / 12,314 |
| 100K (Phase 3) | 100,015 | 244,904 | 108 MB | 76 s | 50,000 / 122,441 |
| 300K (Phase 4) | 300,015 | 735,506 | 290 MB | 177 s | 150,000 / ~368,000 |
| 500K (probe) | 500,015 | 1,225,830 | 493 MB | 293 s | 250,000 / ~613,000 |

Seed throughput is flat at ~5,800 rows/s (batched 500-row `INSERT`s, RLS
enforced). Document expiry mix holds at 70 % VALID / 25 % EXPIRING_SOON /
5 % EXPIRED at every size.

---

## 4. Single-client latency scaling (warm, p50 ms, Alpha)

| endpoint | 10K | 100K | 300K | 500K | shape |
|---|---|---|---|---|---|
| `GET /health/ready` | 5 | 4 | 4 | 4 | **O(1) — flat** |
| `GET /dashboard/expiring?withinDays=30` | 21 | 5 | 38 | ~45 | **O(limit) — flat** |
| `GET /dashboard/summary` | 23 | 87 | 172 | ~250* | O(n) docs |
| `GET /dashboard/document-stats` | 25 | 125 | 200 | ~240* | O(n) docs |
| `GET /employees?page=N` | ~8 | 120 | 237 | ~220 | O(n) emp (sort) |
| `GET /employees/:id/documents` | — | ~90† | ~90 | ~340† | O(n) docs (no index) |
| `GET /employees?q=<term>` | —‡ | 888 | 1,840 | ~3,120 | O(n) emp (dead GIN) |

\* server-side EXPLAIN (cold) — warm e2e was lower and noisier at 500K.
† EXPLAIN ANALYZE server-side.
‡ the 10K baseline measured `?search=` — not a real parameter (the controller
reads `?q=`); the 10K row is an unfiltered list-page timing, so `?q=` full-text
search was first measured at 100K.

**Every non-flat row grows ~2× per 2–3× of data** — linear, no acceleration.

---

## 5. Throughput scaling (k6 read-mix, sustainable req/s)

| seed | sustainable rate | knee | at the knee |
|---|---|---|---|
| 100K | ~30 req/s | 30 → 45 | ≥45: API event-loop starves (`/health/ready` p95 → 1 s) *before* Postgres saturates |
| 300K | ~10 req/s | 10 → 20 | ≥20: full collapse (all endpoints 3 s+, health 1.9 s, iterations shed) |

Sustainable throughput drops **~1/n** with dataset size — the direct
consequence of `O(n)`-per-request work. Under overload, Postgres is CPU-bound
(~1300 % / ~13 cores at 80 req/s on the 100K seed) from parallel-query workers
fanning out across ~15 concurrent pool connections; the single Node API
process hits an event-loop wall before that.

---

## 6. Query-plan analysis — why each path scales the way it does

| path | plan | verdict |
|---|---|---|
| `dashboard/expiring` | Index Scan `idx_documents_expiry (tenant_id, expiry_date)` → `LIMIT 20` | **O(limit)** ✅ |
| `health/ready` | `SELECT 1` + Redis `PING` | **O(1)** ✅ |
| `dashboard/summary` | Parallel Index-Only Scan `idx_documents_status` → GroupAggregate over *all* the tenant's live docs | O(n) — rollup needed |
| `dashboard/document-stats` | Parallel Index Scan `idx_documents_type_status` → Sort → GroupAggregate, all tenant docs | O(n) — rollup needed |
| `employees?page=N` | Index Scan `idx_employees_tenant` → top-N heapsort of the tenant's whole active set (`ORDER BY created_at`, uncovered) | O(n) — needs `(tenant_id, created_at) WHERE deleted_at IS NULL` |
| `employees/:id/documents` | Parallel Index Scan `idx_documents_tenant` → filter `employee_id` in memory (Rows Removed: the tenant's *entire* doc set) | O(n) — **no index on `documents.employee_id` at all** |
| `employees?q=<term>` | Parallel Bitmap Heap Scan `idx_employees_tenant` → recompute `to_tsvector()` per row | O(n) — **the GIN index `idx_employees_search` is never chosen once the query carries the RLS `tenant_id` predicate** (`idx_scan` = 0 across every load run) |

The two flat paths were both designed as bounded lookups. The five `O(n)`
paths all do "scan the tenant's rows, then aggregate/filter/sort in memory" —
correct, just unindexed for the shape the query actually takes.

---

## 7. Resilience & backup/restore (Phase 5)

### Failure matrix

| injection | API | worker | recovery |
|---|---|---|---|
| Postgres `docker restart` | **crash** | **crash** | container `restart:` policy only (hard restart, in-flight lost, drain skipped) |
| `pg_terminate_backend` (1 idle conn) | **crash** | (same path) | same |
| Redis stop/start | survives, `/health/ready` → 503 → ready | survives (ioredis reconnect) | **automatic**, ~10 s |
| Keycloak stop/start | survives, cached-JWKS calls stay 200 | unaffected | new logins resume when back |
| SMTP (MailHog) down + scan | survives | `notification_log` → FAILED rows | **self-heals** next scan (ADR-026) |
| worker kill + 16k-job backlog | — | BullMQ reclaims & drains all | **automatic**, no jobs lost |

**Root cause of the two crashes:** `packages/database/src/index.ts`
`createDb()` builds `new Pool()` with no `pool.on('error')`. `pg-pool`
re-emits a backend `57P01` on idle clients as an unhandled `'error'` event →
Node `throw` → exit. Both processes use `createDb()`. The Redis path, by
contrast, has ioredis auto-reconnect *and* an explicit
`redis.on('error', () => undefined)` guard in `HealthService`.

### Backup / restore drill (300K seed)

| step | result |
|---|---|
| `pg_dump -Fc` (live stack, no window) | 13.5 s → 45.5 MB |
| `pg_restore` into scratch DB | 39 s, 0 errors |
| row counts (emp / docs / tenants / audit) | **identical**: 300,015 / 735,506 / 8 / 1,203 |
| RLS + `FORCE RLS` + `NULLIF` guard + 8 `tenant_isolation_*` policies | **preserved and enforcing** (Alpha ctx → only Alpha, empty ctx → 0) |
| `audit_events` append-only grant | **preserved** (`UPDATE`/`DELETE` → permission denied) |

Roles are cluster-global and need `pg_dumpall --roles-only` separately. Full
procedure: **`docs/runbooks/backup-restore.md`** (new, every command verified).

---

## 8. E7 backlog (prioritised)

| # | item | where | effort | impact |
|---|---|---|---|---|
| 1 | `pool.on('error', …)` in `createDb()` | `packages/database/src/index.ts` | 1 line (review-gated file) | stops a Postgres blip / idle-conn kill from crashing API + worker |
| 2 | index `documents(employee_id)` | migration | 1 index | fixes `employees/:id/documents` O(n) **and** the O(n²) hard-delete (teardown hung 11 min at 100K) |
| 3 | composite full-text index `(tenant_id, <tsvector>)` (btree_gin) or stored `tsvector` column | migration | 1 index | `employees?q=` 900 ms → target <10 ms; the GIN index is currently dead weight |
| 4 | per-`(tenant, status)` / `(tenant, doc_type, status)` rollup, maintained where `expiry_status` is written | migration + service | moderate | `dashboard/summary` + `document-stats` O(n) → O(1) |
| 5 | index `(tenant_id, created_at) WHERE deleted_at IS NULL` on `employees` | migration | 1 index | removes the list-page sort |
| 6 | reminder scan: batch the dedup (one anti-join per tenant, not N point-lookups); bound the candidate scan to threshold dates | `apps/worker` | moderate | scan 20 s→? at 61k candidates, ~100 s at 183k; drops the long per-tenant read txn |
| 7 | worker `IORedis` `.on('error')` (quiet the `ECONNABORTED` log spray) | `apps/worker/src/main.ts` | 1 line | cosmetic |
| 8 | production monitors: JWKS-fetch failures, SMTP circuit-breaker, `notification_log` failure-rate (endpoint already exists, E4 Pillar 4) | ops | — | operability |
| 9 | managed backups / WAL archiving / PITR | AWS epoch | — | DR |

Items 2–5 are each a single additive index/table — the same "purely additive"
shape as every migration since `009_*`. Item 1 is the highest value for
effort.

---

## 9. Verdict

E6's question was *"does this system work at production scale?"* The answer:
**functionally yes, operationally with known limits.**

- Correct at 300K (178/178, zero isolation leaks, backup/restore sound).
- Degrades linearly and predictably — capacity is a function of dataset size
  that §8 items 2–5 move from `O(n)` to `O(1)`/`O(log n)`.
- Self-heals from every dependency failure except a Postgres connection reset
  (§8 item 1, one line).

No blocker. Proceed to E7 with §8 as the opening backlog.
