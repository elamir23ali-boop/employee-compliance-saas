# E6 Phase 1 — Seed Infrastructure

Status: COMPLETE

## What was built

`tools/seed/` (validation tooling only — never imported by `apps/**` /
`packages/**`, never runs in CI or at runtime; typechecked + linted via the
root `tsconfig.json` `include` and `lint` script):

| file | purpose |
|---|---|
| `config.ts` | 5 load-test tenants, doc-type + expiry distributions, batch size |
| `db.ts` | `app_user` pool, `withTenant()` (BEGIN → `set_config('app.current_tenant_id', …, true)` → COMMIT), `--count=` parser |
| `generate.ts` | `npm run generate [-- --count=N]` — faker data, batched multi-row INSERT, one txn per tenant, idempotent |
| `cleanup.ts` | `npm run cleanup [-- --keep-tenants]` — removes 100% of the seed footprint, verifies 0 remain |

Dependencies added (dev only): `@faker-js/faker@9.9.0`. `tsx` was already in
the tree.

## Design decisions

- **5 dedicated load-test tenants** (`slug LIKE 'seed-%'`, ids
  `aaaaaaaa-…-000000000001` … `eeeeeeee-…-000000000005`), disjoint from the 3
  E0 fixture tenants. All employee emails on the reserved `@test.invalid`
  domain (RFC 6761); all names/titles via `@faker-js/faker`. No real
  passport/residence/badge numbers or names.
- **Batched multi-row `INSERT`, never `COPY FROM`** — `COPY` does not apply
  RLS `WITH CHECK` the way `INSERT` does, and this repo's whole security model
  is RLS. 500 rows/statement, one transaction per tenant, `SET LOCAL`
  tenant context as the first statement (identical to real app writes).
- **`app_user` connection for generate**; `cleanup` runs as `migration_user`
  (BYPASSRLS) — deviation from the brief, forced by GRANTs: `notification_log`
  is INSERT-only for `app_user` (ADR-025), and `app_user` has no DELETE on
  `tenant_notification_policies` / `import_batches` / `expiry_policies`. This
  is exactly how `tests/support/db-cleanup.ts` already handles teardown.
- **`expiry_status` written directly** to match what the Expiry Engine would
  compute under the default policy (widest window 90d, grace 0, autoBlock
  false): `expired` → EXPIRED, `critical`/`expiring_soon` → EXPIRING_SOON,
  `valid` → VALID. Expiry dates are UTC calendar-date strings (ADR-033).
- **Idempotent**: `generate` skips any tenant that already has a
  `@test.invalid` employee and prints a warning.

## Validation run (`--count=1000`)

| step | result |
|---|---|
| `npm run generate -- --count=1000` | 1,000 employees + ~2,450 documents in **1.3 s** |
| distribution check | doc-type 91 / 84 / 71 % (cfg 90/85/70); expiry VALID 71 % / EXPIRING_SOON 24.5 % / EXPIRED 4.5 % (cfg 70/25/5) |
| E0 fixtures | 15 employees across tenants A/B/C — **untouched** |
| all 3 suites, seed present | **178/178** (unit 90 / security 52 / integration 36); 3 consecutive clean security runs; no slowdown vs baseline |
| `npm run cleanup` | removed 1,000 emp + ~2,450 docs + notification_log rows the reminder scanner had written for seed tenants + 5 tenant rows; verified 0 `@test.invalid`, 0 seed tenant rows |
| all 3 suites, after cleanup | **178/178**; DB back to exact E0 baseline (15 employees / 3 tenants) |

## Test change: RLS-06 (ADR-034)

`tests/security/rls.test.ts` RLS-06 did an **unscoped** `SELECT * FROM
employees` over the BYPASSRLS `migration_user` connection and asserted
`rowCount === 15`. Any employee seeding breaks it (there is no seed-side fix —
every E6 load target reads `public.employees`). Approved change: scope the
query to `tenant_id = ANY([A,B,C])`, still assert `=== 15`. The
BYPASSRLS-sees-all-tenants-with-no-context point is intact; the assertion is
no longer coupled to the global table contents. Full rationale in ADR-034.

## Pre-existing issue surfaced (not fixed here — out of Phase 1 scope)

`tests/security/tenant-isolation-e2.test.ts` RLS-E2-02 inserts a
`DOC-E2-ISO-01` document against the **permanent** E0 fixture employee
`EMP-B1` on every run and never deletes it — `cleanupE2TestEmployees()` only
sweeps `EMP-<prefix>`-coded employees and their child rows, and `EMP-B1` is an
E0 fixture. ~16 such rows have accumulated in this environment's database
since E2 (2026‑08‑25 →). Harmless (no test counts documents on `EMP-B1`), but
it means the `documents` table has no fixed baseline count. Flagged for a
follow-up test-hygiene fix; recorded here because surfacing this class of
drift is part of what E6 is for.
