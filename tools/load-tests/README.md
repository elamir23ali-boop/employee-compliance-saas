# E6 load tests (`tools/load-tests/`)

Validation tooling only. Never imported by `apps/**` / `packages/**`, never
runs in CI. Drives the running local stack with [k6](https://k6.io) to measure
the API's read paths against a large synthetic seed (E6 Phase 3 = 100k
employees, Phase 4 = stress beyond).

## Prerequisites

1. **k6 on `PATH`** — stock `k6 run`, no xk6 extensions. Download the single
   binary from <https://github.com/grafana/k6/releases> (`k6-vX-windows-amd64.zip`
   → put `k6.exe` somewhere on `PATH`), or `winget install k6 --source winget`.
2. The full local stack up: `npm run docker:up`, then `apps/api` and
   `apps/worker` running from `dist/` (`npm run build` first).
3. Seed data + seed Keycloak users:
   ```
   npm run seed:users          # one hr-manager per seed tenant (ADR-035)
   npm run generate            # 100k employees (configured per-tenant counts)
   ```

## Run

```
npm run loadtest:smoke                     # 1 VU, sanity-check every endpoint 200s
npm run loadtest:read-mix                  # default: 80 req/s, 30s ramp + 3m hold
k6 run -e REQ_RATE=150 -e HOLD=5m tools/load-tests/scenarios/read-mix.js
k6 run -e SUMMARY_JSON=results/run.json tools/load-tests/scenarios/read-mix.js
```

`setup()` mints one access token per seed tenant via Keycloak ROPC (same grant
as `tests/support/keycloak-client.ts`). The e0-test realm issues **300s**
tokens, so keep any single run under ~4 minutes; for longer soaks run
back-to-back. `npm run loadtest:tokens` writes the same tokens to
`.tokens.json` (gitignored) for manual `curl` spot-checks.

## Workload

`lib/workload.js` — weighted read mix modelling a compliance-dashboard session:

| weight | endpoint |
|---|---|
| 26% | `GET /api/v1/dashboard/summary` |
| 20% | `GET /api/v1/dashboard/document-stats` |
| 18% | `GET /api/v1/dashboard/expiring?withinDays=` |
| 14% | `GET /api/v1/employees?q=` (full-text) |
| 12% | `GET /api/v1/employees?page=` (list page) |
|  7% | `GET /api/v1/employees/:id/documents` (per-employee drill-down) |
|  3% | `GET /health/ready` |

`setup()` also fetches one real employee id per tenant so the drill-down hits
a populated row.

Tenant per iteration is picked weighted by employee count (Alpha 50 / Beta 25 /
Gamma 15 / Delta 7 / Epsilon 3), so the 50k-employee tenant takes the brunt.

## Results

Written up in `docs/e6-results/`. Raw k6 JSON goes in `results/` (gitignored).
