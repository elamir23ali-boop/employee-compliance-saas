# E0 Architecture Validation

## Purpose

E0 exists to prove -- before any production code is written -- that the
riskiest architectural decisions for this multi-tenant SaaS actually hold up:
shared-database RLS tenant isolation, connection-pool-safe `SET LOCAL`
tenant context, Keycloak OIDC + TOTP auth, server-side RBAC, and
tenant-scoped BullMQ workers. This is a proof of concept only -- not an MVP,
not production code.

## What was built

| Layer | Implementation |
|---|---|
| Database | PostgreSQL 18, `app_user` (FORCE RLS, no BYPASSRLS) + `migration_user` (BYPASSRLS, migrations only) |
| Tenant isolation | RLS policies on `employees`, `documents`, `idempotency_keys`, keyed on `current_setting('app.current_tenant_id')` |
| Tenant context propagation | `SELECT set_config('app.current_tenant_id', $tenantId, true)` as the first statement of every transaction (request path and both workers) |
| Auth | Keycloak 26.7.2, OIDC direct-grant + TOTP for `admin_tenant_a`, JWKS-verified JWTs |
| Tenant resolution | `org_slug` JWT claim -> DB lookup against `tenants` (no RLS on that table) -> tenant UUID -- never trusts a client-supplied tenant ID |
| RBAC | Server-side role hierarchy guard (`viewer < hr-staff < hr-manager < tenant-admin < platform-admin`) |
| Workers | BullMQ `reminders`/`imports` queues, each job validates `tenantId`, sets tenant context per-transaction, and is idempotency-key deduplicated |
| ORM | Drizzle ORM (`drizzle-orm/node-postgres`), `app_user`-only in application code |

## Request flow (as implemented)

```
HTTP request
  -> AuthGuard: verify JWT (JWKS signature, issuer, audience, expiry, typ=Bearer)
  -> TenantMiddleware (Guard, see decisions.md #9): org_slug from JWT -> tenants lookup -> tenant UUID
  -> RbacGuard: role hierarchy check against @Roles() metadata
  -> EmployeesService.findAll(): db.transaction() -> SET LOCAL tenant context -> query -> commit
  -> Response { data, total, tenant_id }
```

## Key findings

Two non-obvious, empirically-verified Postgres/Keycloak behaviors were
discovered during validation and are documented in full in `decisions.md`:

1. **Postgres**: a custom GUC's `SET LOCAL` reset-on-commit value is `''`,
   not `NULL`, when the GUC had no prior session-level value. Fixed with a
   `NULLIF` guard in the RLS policies (decisions.md #3). Fail-closed either
   way -- no data was ever at risk.
2. **Keycloak**: OTP secrets are keyed as raw UTF-8 bytes, not Base32-decoded
   (decisions.md #4); TOTP codes are single-use per window (decisions.md #5);
   the default User Profile requires `firstName`/`lastName` (decisions.md
   #6); the token endpoint returns 400 (not 401) for `invalid_grant`
   (decisions.md #7); and `iss` reflects the request's Host header unless
   pinned (decisions.md #8).

None of these findings weakened tenant isolation or required bypassing a
security control to work around -- each was fixed either by correcting a
test's expectation to match real, documented protocol/DB behavior, or by
hardening the RLS policy / Keycloak config to be robust against it.

## Result

All 19 security/functional tests pass (see `security-results.md`). All 3
performance scenarios ran cleanly with zero cross-tenant contamination under
20-VU concurrent load (see `performance-results.md`). See the final E0 report
for the full recommendation.
