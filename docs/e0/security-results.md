# E0 Security Results

All 19 tests executed against a live local stack (Postgres 18, Keycloak
26.7.2, Redis 7, the NestJS app) via `npx vitest run` from the repo root.
Full run: 5 files, 19 tests, 19 passed, 0 failed.

| Test ID | Test Name | Expected | Actual | Evidence | PASS/FAIL |
|---|---|---|---|---|---|
| RLS-01 | Tenant A reads own data | 5 rows, all tenant_id = A | 5 rows, all tenant_id = A | `rls-tests/rls.test.ts` | PASS |
| RLS-02 | Tenant B context, WHERE targets tenant A | 0 rows | 0 rows | `rls-tests/rls.test.ts` | PASS |
| RLS-03 | No tenant context set | 0 rows | 0 rows | `rls-tests/rls.test.ts` | PASS |
| RLS-04 | Forged non-existent tenant UUID | 0 rows | 0 rows | `rls-tests/rls.test.ts` | PASS |
| RLS-05 | app_user cannot assume migration_user role | error thrown | `permission denied to set role "migration_user"` | `rls-tests/rls.test.ts` | PASS |
| RLS-06 | migration_user bypasses RLS | 15 rows (all tenants) | 15 rows | `rls-tests/rls.test.ts` | PASS |
| POOL-01 | SET LOCAL resets after commit | Tx2 = 0 rows | 0 rows (after RLS policy `NULLIF` fix -- see decisions.md #3) | `pooling-tests/pooling.test.ts` | PASS |
| POOL-02 | 20 concurrent requests, no cross-tenant leak | 0 cross-tenant rows | 0 cross-tenant rows (10 tenant-A + 10 tenant-B responses) | `pooling-tests/pooling.test.ts` | PASS |
| POOL-03 | Pool reuse across tenants, no stale context | tenant-B response has no tenant-A rows | confirmed | `pooling-tests/pooling.test.ts` | PASS |
| KC-01 | Valid authentication (TOTP) works end-to-end | 200, 5 employees | 200, 5 employees | `auth-tests/keycloak.test.ts` | PASS |
| KC-02 | Wrong password rejected | Keycloak rejects (400 `invalid_grant`, corrected from spec's assumed 401 -- see decisions.md #7) | 400 `invalid_grant` | `auth-tests/keycloak.test.ts` | PASS |
| KC-03 | Expired token rejected by API | 401 | 401 | `auth-tests/keycloak.test.ts` | PASS |
| KC-04 | Corrupted JWT signature rejected | 401 | 401 | `auth-tests/keycloak.test.ts` | PASS |
| KC-05 | Disabled user cannot get a token | Keycloak rejects (400 `invalid_grant`, corrected from spec's assumed 401) | 400 `invalid_grant` | `auth-tests/keycloak.test.ts` | PASS |
| WORKER-01 | Valid job processed successfully | job completes, idempotency key stored | confirmed via migration_user query | `worker-tests/worker.test.ts` | PASS |
| WORKER-02 | Job without tenantId discarded | failed state, no data written | job state = failed, 0 idempotency rows | `worker-tests/worker.test.ts` | PASS |
| WORKER-03 | Duplicate idempotencyKey processed once | 1 row | 1 row (2 jobs enqueued, 1 idempotency row) | `worker-tests/worker.test.ts` | PASS |
| AUTH-01 | Viewer cannot write | 403 | 403 | `rbac-tests/rbac.test.ts` | PASS |
| AUTH-02 | HR staff blocked from admin endpoint | 403 | 403 | `rbac-tests/rbac.test.ts` | PASS |

**19/19 PASS. Zero cross-tenant data leaks observed in any test, including
under the 20-VU concurrent load test (PERF-03, see performance-results.md) --
8,428 requests, 0 cross-tenant rows.**

## Notable non-failures worth flagging

- **POOL-01** surfaced a real Postgres subtlety (empty-string vs NULL on
  `SET LOCAL` revert) that, unfixed, would have produced a hard SQL error
  instead of a clean empty result on a specific edge case -- fail-closed, no
  data ever at risk, but worth the RLS policy hardening documented in
  decisions.md #3.
- **KC-02/KC-05** initially failed only because the original spec assumed
  HTTP 401 where Keycloak's token endpoint actually (and correctly, per
  OAuth2) returns 400. The underlying security property -- bad credentials
  are rejected -- held from the first run; only the assertion needed
  correcting.
