# CLAUDE.md — Employee Compliance SaaS

## Project

Security-first multi-tenant SaaS — employee document compliance for UAE companies.
Multi-tenant: Shared PostgreSQL + Row-Level Security (RLS).

## Current Phase: E3 complete — CI/CD Hardening, Reminder Engine, Excel Import/Export, Dashboard APIs

- E0 complete: 19/19 security tests PASS (auth, RLS, RBAC, pooling baseline).
- E1 established the repository structure, CI, and monorepo layout only.
- E2 complete: 85/85 tests PASS (31 unit / 32 security / 22 integration).
  Delivered: extended employee records (soft delete, full-text search),
  documents + the Expiry Engine (`VALID`/`EXPIRING_SOON`/`RENEWAL_IN_PROGRESS`/
  `EXCEPTION`/`EXPIRED`/`BLOCKED`), an append-only audit trail, and optimistic
  locking on writes. See `docs/architecture/decisions.md` (ADR-020..023) for
  the design decisions this phase made and why.
- E3 in progress. Pillar 1 (CI/CD hardening) complete: `.github/workflows/ci.yml`
  restructured into 5 sequentially-gated stages (lint → unit-tests →
  integration → security-scan → build); the `integration` stage runs
  `docker compose` (Postgres+Redis+Keycloak) plus the API/worker processes,
  closing the ADR-023 CI gap for `test:security`/`test:integration`'s
  HTTP+Keycloak-dependent tests. See ADR-024.
- E3 Phase 2 (schema for Pillars 2-4: `tenant_notification_policies`,
  `notification_log`, `import_batches`, dashboard index) complete — see
  ADR-025.
- E3 Phase 3 (Pillar 2 — Reminder Engine) complete: a daily BullMQ scan
  (`apps/worker/src/workers/reminder-scanner.worker.ts`) finds documents
  crossing a tenant's configured reminder thresholds, enqueues per-document
  jobs, and `reminder.worker.ts` dispatches (currently a log-only stub,
  `EmailDispatcher`/`LogEmailDispatcher`) and records the outcome in
  `notification_log`. A `GET`/`PATCH /api/v1/notification-policy` endpoint
  (tenant-admin only) lets tenants view/edit their own cadence. See
  ADR-026 for the cadence rule, the idempotency-on-terminal-outcome design,
  and the stub-dispatcher decision. Real SMTP/SES sending remains
  unimplemented (explicit gap, not a phase-scope oversight).
- E3 Phase 4 (Pillar 3 — Excel Import/Export) complete: `POST
  /api/v1/imports/employees` (hr-staff+) accepts an `.xlsx` upload,
  processes each row in its own transaction (partial success is expected:
  "43 succeeded, 5 failed"), upserts via the same `EmployeesService.create`/
  `.update()` single-employee write path, and returns a batch summary plus
  per-row error detail. Re-uploading identical bytes (SHA-256-matched) is
  idempotent (`import_batches.file_hash`, ADR-025). `GET
  /api/v1/imports/:id` re-fetches a batch's stored summary; `GET
  /api/v1/exports/employees` (hr-manager+) downloads an `.xlsx` of active
  employees. See ADR-027 for the per-row-transaction/reused-write-path
  design and the `exceljs`→`uuid` accepted residual `npm audit` finding.
- E3 Phase 5 (Pillar 4 — Dashboard APIs) complete, closing out E3: three
  read-only, viewer-level endpoints built directly on ADR-025's
  dashboard-specific indexes — `GET /api/v1/dashboard/summary` (total +
  zero-filled per-`ExpiryStatus` counts, `idx_documents_status`), `GET
  /api/v1/dashboard/document-stats` (per-`(docType, expiryStatus)` counts,
  `idx_documents_type_status`), and `GET /api/v1/dashboard/expiring`
  (paginated, `?withinDays=`/`?docType=`-filterable, `idx_documents_expiry`).
  No new tables/columns/indexes/RLS — pure query work, no ADR needed.
  Employee headcount/department stats were explicitly scoped out (no
  supporting index; would need its own migration).

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
- Current state: 128/128 passing (53 unit / 46 security / 29 integration)
- **CI gap (ADR-023) addressed in E3 Pillar 1 (ADR-024), pending live verification:**
  `.github/workflows/ci.yml`'s `integration` job now runs `docker compose`
  (Postgres+Redis+Keycloak) directly on the runner — not GitHub Actions
  `services:`, which can't bind-mount local files — plus the API/worker
  processes, then runs both `test:security` and `test:integration` against
  that live stack. Validated locally via `docker compose config` only (this
  environment's own dev containers occupy the same ports/project name, so a
  full local dry-run would collide with them); a real GitHub Actions run on a
  pushed branch/PR is still needed to confirm all 5 stages actually go green
  before this is called closed.
- Every test file that creates real rows via the API must clean up after
  itself (`tests/support/db-cleanup.ts` + `afterAll` hooks) — `tests/security/**`
  runs with `fileParallelism: false` against one shared database, so an
  uncleaned row silently drifts other suites' exact row-count assertions
  (e.g. E0's `rls.test.ts`), in CI exactly as much as locally (ADR-023).

## Git Rules

- Never force push to main
- Never commit .env.local or any real secrets
- Every security-sensitive change needs a clear commit message explaining why
