# E0 Performance Results

Load generated with `k6` (via the `grafana/k6` Docker image, since no local
k6 binary was available) against the app running on the host
(`npm run start` from `/app`), hitting Postgres/Keycloak/Redis via Docker
Compose. Raw k6 summaries: `test-results/k6-summary-{raw,employees,mixed}.json`;
consolidated: `test-results/k6-results.json`.

| Scenario | p50 (ms) | p95 (ms) | p99 (ms) | RPS | Error % | CPU % | Mem MB | DB Conns |
|---|---|---|---|---|---|---|---|---|
| PERF-01 (raw-query, migration_user, bypasses RLS) | 5.84 | 6.64 | 7.77 | 152.8 | 0 | ~1% (idle baseline, Postgres container) | 35 (Postgres container, idle baseline) | n/a (raw pg client, not pooled app connection) |
| PERF-02 (/api/v1/employees, RLS-protected, tenant-A JWT) | 18.21 | 19.67 | 20.67 | 51.0 | 0 | -- | -- | -- |
| **RLS overhead delta (PERF-02 - PERF-01)** | **+12.37** | **+13.03** | **+12.90** | -33.6 | -- | -- | -- | -- |
| PERF-03 (mixed tenants, 20 VUs / 30s, 10xA + 10xB JWTs) | 68.06 | 86.13 | 100.61 | 278.1 | 0 | Postgres: 92.1% (burst sample); app (Node): working set ~154MB (burst sample) | see note | active conns: 3 (idle post-burst sample) |

8,428 total requests in PERF-03, **0 cross-tenant rows in any response**
(`no cross-tenant rows` check: 8,428/8,428 pass).

## Notes / methodology caveats

- CPU/Mem for PERF-03 were sampled once mid-burst via `docker stats
  --no-stream` (Postgres container) and `Get-Process node` (app process)
  from a separate PowerShell session while the 30s k6 run was in flight --
  a single snapshot, not a continuous trace. Treat as indicative, not a
  rigorous profile.
- DB Conns is a post-burst snapshot of `pg_stat_activity` for `e0db`
  (queried via `migration_user`), not a peak-concurrency trace. The app's
  pool is configured `min: 2, max: 10` (per spec); observed active
  connections at rest were well under the max.
- PERF-01's endpoint (`/api/v1/perf/raw-query`) uses its own small
  `migration_user` `pg.Pool` (`max: 5`), separate from the app's `app_user`
  pool used by PERF-02/PERF-03 -- so "DB Conns" isn't directly comparable
  between PERF-01 and the other two rows.
- RPS is lower for PERF-02 than PERF-01 partly because `shared-iterations`
  with `vus: 1` serializes 100 iterations single-threaded; the *duration*
  delta (p50/p95/p99) is the meaningful RLS-overhead signal, not RPS.
- This is a POC-scale, single-machine measurement (Docker Desktop on
  Windows, all services local) -- absolute numbers will not transfer to a
  production deployment topology. The useful signal is the *relative* RLS
  overhead (~12-13ms p50/p95 added by auth + tenant resolution + RLS vs. a
  raw bypass query) and that zero cross-tenant contamination occurred under
  concurrent multi-tenant load.
