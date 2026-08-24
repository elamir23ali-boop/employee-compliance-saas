# Threat Model

Scope: the architecture validated in E0 and structurally established in E1 --
shared-database multi-tenant SaaS, RLS tenant isolation, Keycloak OIDC+TOTP
auth, server-side RBAC, BullMQ workers. This is not a full STRIDE workshop
output; it's a working reference for the threats the locked architecture
decisions (CLAUDE.md) exist to close off, and what would have to fail for
each to reopen.

## Trust boundaries

```
Internet
  │
  ▼
Keycloak (OIDC + TOTP)  ──issues──▶  JWT (org_slug, realm_access.roles)
  │
  ▼
apps/api (AuthGuard → TenantMiddleware → RbacGuard → handler)
  │
  ▼
Postgres (app_user, FORCE RLS)  ◀── SET LOCAL app.current_tenant_id per transaction
  │
  ▼
apps/worker (BullMQ jobs carry tenantId in payload, not global state)
```

## Threats and controls

| #   | Threat                                                                                       | Control                                                                                                                                                                                                                                   | Where                                                       |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| T1  | Cross-tenant data read via a forged/omitted tenant ID                                        | Tenant ID is never accepted from the client; it's resolved server-side from the verified JWT's `org_slug` → DB lookup, then set via `SET LOCAL` for the transaction only                                                                  | `tenant.middleware.ts`, `tenant.resolver.ts`, `003_rls.sql` |
| T2  | Tenant context leaking across pooled connections between requests                            | `SET LOCAL` (via `set_config(..., true)`) is transaction-scoped and resets on COMMIT/ROLLBACK; verified empirically (POOL-01/02/03)                                                                                                       | `employees.service.ts`, both workers                        |
| T3  | RLS bypass in application code                                                               | `app_user` has no `BYPASSRLS`; tables are `FORCE ROW LEVEL SECURITY`; `migration_user` (which does have `BYPASSRLS`) is never constructed with application code, except the one hard-gated, `NODE_ENV=test`-only perf diagnostic endpoint | `001_roles.sql`, `003_rls.sql`, `perf.controller.ts`        |
| T4  | Forged/expired/tampered JWT accepted                                                         | Signature verified against Keycloak JWKS, plus issuer/audience/expiry/`typ` checks                                                                                                                                                        | `auth/jwt.strategy.ts`                                      |
| T5  | Issuer confusion (a token from an unpinned/attacker-controlled issuer accepted)              | `KC_HOSTNAME` pinned so `iss` is deterministic; `jwt.strategy.ts` validates against a single configured `KEYCLOAK_ISSUER`                                                                                                                 | `infra/docker/docker-compose.yml`, ADR-008                  |
| T6  | Privilege escalation via role claims                                                         | Role hierarchy check is server-side only (`RbacGuard` + `ROLE_HIERARCHY`), never trusts a client-supplied role                                                                                                                            | `rbac.guard.ts`                                             |
| T7  | Worker processes a job for a tenant that doesn't exist/is inactive, or with no tenant at all | Every job payload is Zod-validated; jobs without a valid `tenantId` are discarded; tenant is re-checked (`status = 'active'`) inside the transaction before any write                                                                     | `apps/worker/src/workers/*.worker.ts`                       |
| T8  | Duplicate job processing (e.g. retries) causing duplicate side effects                       | Idempotency key uniqueness enforced via `idempotency_keys` (itself RLS-protected)                                                                                                                                                         | `003_rls.sql`, worker files                                 |
| T9  | Secrets committed to the repo                                                                | `.gitignore` excludes `.env.local`/`*.env`; `.github/workflows/security.yml` runs TruffleHog on every CI push                                                                                                                             | `.gitignore`, `ci.yml`                                      |
| T10 | Vulnerable dependency introduced                                                             | `npm audit` gated in CI (`security-audit` job, `--audit-level=high`) plus a weekly scheduled scan                                                                                                                                         | `ci.yml`, `security.yml`                                    |
| T11 | PII in logs                                                                                  | Worker/service logs only ever include `tenantId.substring(0, 8)`, job IDs, and action names -- never names, document numbers, or full UUIDs                                                                                               | worker files                                                |

## Explicitly out of scope for E0/E1

No production deployment topology, no WAF/network-layer controls, no
key-rotation procedure, no incident-response runbook, no billing/metering
attack surface (billing doesn't exist yet). These belong to a later phase
and should be added here when built, not speculated about now.

E4 (see `docs/architecture/decisions.md` ADR-028 onward) begins closing
some of these: live CI verification, containerization/image scanning, real
notification delivery, and failure observability. Deployment topology,
WAF/network controls, key rotation, incident response, and billing remain
open and out of scope until a phase explicitly claims them.
