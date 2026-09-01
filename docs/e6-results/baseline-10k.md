# E6 Phase 2 — Baseline (10K)

Status: COMPLETE

## Environment

| | |
|---|---|
| Host | Windows 11, 15.3 GB RAM (~6 GB free), Docker Desktop (Linux engine) |
| Postgres | `postgres:18-alpine`, container `docker-postgres-1`, named-volume data |
| **Timezone** | host UTC+4; Postgres container UTC (see ADR-033) |
| API / worker | `apps/api` + `apps/worker` from built `dist/`, run on the host |
| `pg_stat_statements` | **ENABLED** — `ALTER SYSTEM SET shared_preload_libraries='pg_stat_statements'` + container restart + `CREATE EXTENSION`. `pg_stat_statements.track='all'`, `.max=10000`. |

## Seed / DB state

`npm run generate -- --count=10000` → 10,000 employees + 24,520 documents in **7.5 s**
(one transaction per tenant, batched 500-row INSERTs).

| metric | value |
|---|---|
| employees (total / seed) | 10,015 / 10,000 |
| documents (total) | 24,567 |
| tenants | 8 (3 E0 + 5 seed) |
| **database size** | **21 MB** |
| `employees` table + indexes | 5.6 MB |
| `documents` table + indexes | 6.2 MB |

Per-tenant employees: Alpha 5,000 · Beta 2,500 · Gamma 1,500 · Delta 700 · Epsilon 300 · (E0 A/B/C 5 each).
Document expiry mix (all tenants): VALID 17,175 (70 %) · EXPIRING_SOON 6,126 (25 %) · EXPIRED 1,266 (5 %) — matches config.

Auth for the measured endpoints: runtime Keycloak users, one `hr-manager` per seed
tenant (`npm run seed:users`, ADR-035). Largest tenant = **Alpha Corp (5,000
employees, 12,314 documents)** — all measurements below are against Alpha's token.

## Test suite with 10K seed present

`unit 90/90 · security 52/52 · integration 36/36` = **178/178**. Security suite 87 s
(vs ~80–100 s clean baseline — no meaningful slowdown).

## Response times (curl, 20 samples each, warm)

| endpoint | min | p50 | p95 | max |
|---|---|---|---|---|
| `GET /health/ready` (no auth) | 4.7 | 5.4 | 8.6 | 8.6 |
| `GET /api/v1/employees?search=ar` | 29.0 | 30.4 | 116.1 | 116.1 |
| `GET /api/v1/employees?search=<no match>` | 27.7 | 31.8 | 42.1 | 42.1 |
| `GET /api/v1/dashboard/summary` | 21.7 | 22.8 | 30.3 | 30.3 |
| `GET /api/v1/dashboard/document-stats` | 22.9 | 24.7 | 29.7 | 29.7 |
| `GET /api/v1/dashboard/expiring?withinDays=30` | 18.7 | 20.6 | 77.3 | 77.3 |
| `GET /api/v1/exports/employees` (5,000 rows → 306 KB .xlsx) | 550 | ~650 | 958 | 958 |

*(all values ms; p95==max at n=20 is the single slowest sample — cold plan / GC)*

## Query plans (EXPLAIN ANALYZE, tenant context set)

Every hot-path query is index-backed — **no sequential scans on `employees` or
`documents` for the API queries**:

| query | plan | exec |
|---|---|---|
| employees full-text search | Bitmap Index Scan `idx_employees_search` (GIN) | 0.9 ms |
| employees count (`deleted_at IS NULL`) | Index Only Scan `idx_employees_active` | 3.3 ms (scans all rows — **O(n)**) |
| dashboard summary group-by | Index Only Scan `idx_documents_status` → GroupAggregate | 4.6 ms |
| dashboard document-stats group-by | Index Only Scan `idx_documents_type_status` → GroupAggregate | 5.3 ms (**slowest dashboard query**) |
| dashboard expiring (range + LIMIT) | Index Scan `idx_documents_expiry` | 0.5 ms |

`pg_stat_statements` top consumers during a load of each endpoint (10× + 1 export):
`document-stats` group-by 10 ms mean, `summary` group-by 7.8 ms, employees list-page
7.8 ms, employees count 2.7 ms.

## Index usage (`pg_stat_user_indexes`)

All dashboard/search indexes are exercised: `idx_documents_status`,
`idx_documents_type_status`, `idx_documents_expiry`, `idx_employees_search`,
`idx_employees_active`, `idx_employees_tenant`. No unused index of concern
(`idx_audit_tenant_created` at 0 scans is E2 audit infra, not in E6's read paths).

## Reminder scan at 10K

An integration-test-triggered full `reminder-scans` job scanned all 8 active
tenants, found **379 seed documents** landing exactly on a configured
threshold day, enqueued + dispatched all 379 (`notification_log` → SENT,
emails delivered to MailHog) with no failures. Completed well within the test
window.

## Anomalies / watch-items for the stress phases

1. **`employees` count query is O(n)** — `SELECT count(*) FROM employees WHERE
   deleted_at IS NULL` (the list endpoint's `total`). Index-only scan of every
   live row for the tenant. 3 ms at 10K; will grow linearly. Watch at 300K–1M.
2. **`document-stats` group-by is O(n)** in the tenant's document count —
   full index-only scan + aggregate, 5 ms at 12K docs. Same linear concern.
3. **`notification_log` seq-scanned heavily by the workers** — 5,268 seq scans
   in ~15 min of idle worker polling (vs 36 index scans). Negligible at 123
   rows; `notification_log` grows fast under a real reminder load (379 rows
   from one scan here), so revisit whether the failure-alert / dedup queries
   stay index-bound at 100K+ log rows.
4. **Planning time** occasionally 4–14 ms (RLS predicate + partial indexes).
   Amortised by drizzle's parameterised statements; noted, not actioned.
5. Pre-existing `DOC-E2-ISO-01` test leak (Phase 1 notes) — `documents` total
   is 24,567 not 24,560; +7 rows on the E0 `EMP-B1` fixture from prior
   `tenant-isolation-e2` runs. Cosmetic.

## Cleanup

`npm run cleanup` → removed all 10,000 seed employees + 24,520 documents + 379
`notification_log` rows + 5 tenant rows; verified 0 `@test.invalid` remain.
Full suite re-run after cleanup: **178/178**, DB back to E0 baseline (15
employees / 3 tenants). Seed Keycloak users left in place (reused across
phases; `npm run seed:users -- --delete` removes them).
