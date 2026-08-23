# CLAUDE.md — Employee Compliance SaaS

## Project

Security-first multi-tenant SaaS — employee document compliance for UAE companies.
Multi-tenant: Shared PostgreSQL + Row-Level Security (RLS).

## Current Phase: E2 complete — Employee Document Compliance Core

- E0 complete: 19/19 security tests PASS (auth, RLS, RBAC, pooling baseline).
- E1 established the repository structure, CI, and monorepo layout only.
- E2 complete: 85/85 tests PASS (31 unit / 32 security / 22 integration).
  Delivered: extended employee records (soft delete, full-text search),
  documents + the Expiry Engine (`VALID`/`EXPIRING_SOON`/`RENEWAL_IN_PROGRESS`/
  `EXCEPTION`/`EXPIRED`/`BLOCKED`), an append-only audit trail, and optimistic
  locking on writes. See `docs/architecture/decisions.md` (ADR-020..023) for
  the design decisions this phase made and why.
- E3 has not started. No E3 scope (billing, notifications, background
  scheduling, alerting on audit-write failures, CI-in-Keycloak) exists in
  this codebase yet.

## ABSOLUTE PROHIBITIONS

- NEVER use --dangerously-skip-permissions
- NEVER hardcode secrets in source files
- NEVER use migration_user in application runtime code (the one sanctioned
  exception: `PerfController`'s raw-query endpoint, hard-gated to
  `NODE_ENV=test`, see ADR-010 — no other path)
- NEVER bypass RLS in application code
- NEVER trust tenant_id from client — always derive from JWT → DB lookup
- NEVER store tenant context in global or module-level variables — tenant
  context is set via `SET LOCAL`/`set_config(..., true)` scoped to a single
  transaction, every time, including inside BullMQ workers
- NEVER log PII (names, document numbers, emails, full UUIDs) — logs may
  only ever include `tenantId.substring(0, 8)`, job/request IDs, and action
  names (see `docs/architecture/data-classification.md`)
- NEVER use real employee data or real document numbers, at any phase — all
  seed/test data is synthetic (`EMP-A1`, `DOC-A-001`, etc.)
- NEVER pass user input to sql.identifier() or dynamic SQL APIs
- NEVER add features outside current phase scope
- NEVER silently change architecture decisions
- NEVER allow UPDATE or DELETE on `audit_events` from application code —
  it is append-only by grant (`app_user` has SELECT+INSERT only; UPDATE/DELETE
  are revoked at the schema level, `005_audit_events.sql`), not just by
  convention
- NEVER expose `audit_events` rows through the employees/documents read APIs
  or any other HTTP endpoint — audit data is written, never served, in E2
- NEVER let an audit-write failure roll back or block the business
  transaction it's attached to (see the SAVEPOINT pattern, ADR-020) — but
  never let it fail silently either; every audit-write failure must still be
  logged at ERROR level with enough PII-free context to reconcile later

## Locked Architecture (from E0, extended in E2)

- PostgreSQL 18 + RLS + NULLIF guard + FORCE RLS, now covering all
  tenant-owned tables: `employees`, `documents`, `idempotency_keys` (E0),
  plus `audit_events` and `expiry_policies` (E2). `tenants` itself has no RLS
  policy by design — it must be resolvable before tenant context exists.
- app_user: non-superuser, FORCE RLS on every tenant-owned table; SELECT+INSERT
  only on `audit_events` (no UPDATE/DELETE, enforced by GRANT/REVOKE)
- migration_user: BYPASSRLS, migrations only
- Keycloak 26.7.2, KC_HOSTNAME pinned
- TenantMiddleware runs as a NestJS Guard (after AuthGuard, before RbacGuard) —
  never real Express/Nest middleware, since middleware runs before all Guards
  regardless of registration order (ADR-009)
- Request-ID assignment (`request-id.middleware.ts`) is the one exception
  that *is* real NestMiddleware, and deliberately so: it must run before
  every Guard so 401/403/409 error responses still carry a correlation ID
  (ADR-022) — this is request plumbing, not tenant/auth logic, and does not
  reopen the ADR-009 rule above
- SET LOCAL per transaction only, including audit writes (via SAVEPOINT
  inside the caller's transaction — never a separate connection/transaction,
  ADR-020) and worker jobs (tenant_id re-validated against `tenants.status =
  'active'` inside the transaction, never trusted from the job payload alone)
- Drizzle ORM for queries, SQL files for migrations (`packages/database/migrations`,
  mirrored into `infra/postgres/init` for local first-boot; drizzle-kit is
  dev-only introspection, never run against a real database, ADR-012)
- BullMQ workers: tenant_id from job payload only, Zod-validated; a job
  missing or failing that validation is discarded and never processed
  (`apps/worker`, standalone from the API process since E1/ADR-016)
- Optimistic locking: writes to `documents`/`employees` carry a `version`
  column; a stale version is always rejected with 409, never silently
  overwritten or merged
- Audit trail: every write logs a before/after `audit_events` row in the
  same transaction as the business write via a `SAVEPOINT` (ADR-020) —
  append-only, RLS-scoped, never returned by any read endpoint

## Review Gates (require human review before implementing)

- Any RLS policy change
- Any auth or JWT validation change
- Any tenant isolation logic change
- Any database migration
- Any security-related dependency update
- Any change to this CLAUDE.md

## Testing Requirements

- Three suites, run separately: `npm run test:unit` (pure logic, no DB/Keycloak/API
  — Expiry Engine, AuditService with a mocked transaction, EmployeesService
  with a mocked Drizzle handle), `npm run test:security`, `npm run test:integration`
  (both HTTP-driven: require `docker compose up` — Postgres+Redis+Keycloak —
  plus the API (`apps/api`) and worker (`apps/worker`) processes running locally)
- Current state: 85/85 passing (31 unit / 32 security / 22 integration)
- **Known CI gap (carried into E3, not fixed by E2):** `.github/workflows/ci.yml`
  only runs `test:unit` and `test:security`'s Postgres/Redis-only portion in
  CI. The HTTP+Keycloak-dependent tests in `test:security` and all of
  `test:integration` are NOT currently enforced by CI — they require a live
  API process and a Keycloak realm import that GitHub Actions `services:`
  containers can't provision the way local `docker compose` does (see
  ADR-023). These suites are verified locally only today. Closing this gap is
  E3 scope, not something to patch ad hoc.
- Every test file that creates real rows via the API must clean up after
  itself (`tests/support/db-cleanup.ts` + `afterAll` hooks) — `tests/security/**`
  runs with `fileParallelism: false` against one shared database, so an
  uncleaned row silently drifts other suites' exact row-count assertions
  (e.g. E0's `rls.test.ts`), in CI exactly as much as locally (ADR-023).

## Git Rules

- Never force push to main
- Never commit .env.local or any real secrets
- Every security-sensitive change needs a clear commit message explaining why
