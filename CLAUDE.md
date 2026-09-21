# CLAUDE.md — Employee Compliance SaaS

## Project

Security-first multi-tenant SaaS — employee document compliance for UAE companies.
Multi-tenant: Shared PostgreSQL + Row-Level Security (RLS).

## Current Phase: E7 complete — AWS Production Infrastructure (Staging Deployment), plus five post-E7 standalone fixes (pool.on('error') resilience, migration tracking, trust-proxy/audit-IP, dependency CVE remediation, and 3 of E6's 5 O(n) read-path indexes — see below). Not E8: that name is reserved for first real pilot customer onboarding (E7_GATE.md's nextEpoch, ADR-041), which hasn't started.

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
- **E4 in progress.** Pillar 1 (live CI verification) complete: all 5
  `ci.yml` jobs confirmed green on a real GitHub Actions run for the first
  time ever (PR #2), closing the verification gap ADR-024 left open. Two
  real, previously-invisible bugs surfaced and were fixed on that branch:
  (1) the root `tsconfig.json` lacked `experimentalDecorators`, silently
  tolerated until E3 Phase 4 first imported a NestJS controller from a
  `tests/unit` file; (2) `reminder.worker.ts`'s "document not found"
  SUPPRESSED path violated `notification_log`'s real FK to `documents`,
  100% reproducible, masked in this environment for two full phases by a
  stale `idempotency_keys` row predating that code path. See ADR-028 for
  both.
- Pillar 2 (containerization & image security) complete: production
  Dockerfiles for `apps/api`/`apps/worker` (`turbo prune --docker`,
  4-stage build, non-root user, no dev dependencies in the final layer),
  `hadolint` in the `lint` job, and a Trivy image scan in the `build` job
  (deliberately not `security-scan` — see ADR-029). Two more real,
  previously-invisible bugs surfaced building from scratch: a
  `turbo prune` limitation (doesn't follow `tsconfig`'s `extends`) and a
  genuine `@types/eslint-scope` version conflict masked by this
  environment's stable `node_modules` — both fixed, see ADR-029. No
  registry push, no orchestration manifests, no `HEALTHCHECK` — all still
  explicitly deferred (deployment topology).
- Pillar 3 (real notification delivery) complete: `LogEmailDispatcher`
  (ADR-026's stub) is replaced at the `main.ts` wiring point by a real
  `SmtpEmailDispatcher` (`apps/worker/src/notifications/email-dispatcher.ts`),
  generic SMTP via `nodemailer`, config-only (`SMTP_*` env vars) so the
  same code targets a MailHog container in dev/CI
  (`infra/docker/docker-compose.yml`) or any real provider's SMTP
  interface in production. `reminder.worker.ts`'s SENT/FAILED/SUPPRESSED
  and idempotency-key logic is untouched — exactly the seam ADR-026
  built for this. Content is deliberately minimal plain text this phase
  (no HTML templates); `tests/integration/worker.test.ts`'s WORKER-04 now
  asserts a message actually arrived in MailHog, not just that
  `notification_log` reached `SENT`. See ADR-030.
- **Pillar 4 (failure observability) complete, closing out E4.** `GET
  /api/v1/notification-log/stats` (tenant-admin only, `?windowHours=`,
  default 24, 1-720 range) surfaces per-tenant `SENT`/`FAILED`/`SUPPRESSED`
  counts and a failure rate from `notification_log`, strictly scoped to
  the caller's own tenant (no cross-tenant/ops view — none exists
  anywhere in this repo). A new hourly BullMQ scan
  (`apps/worker/src/workers/failure-alert-scanner.worker.ts`) aggregates
  each active tenant's trailing 6h of attempts and emits a structured,
  PII-free `console.error` ALERT line (`notification_failure_rate_alert`)
  when the failure rate crosses a hardcoded threshold
  (`shouldAlertOnFailureRate`, `apps/worker/src/workers/failure-alert-policy.ts`)
  over a minimum sample size — no external alert channel, no
  tenant-configurable threshold yet, no dedup across scans. New index:
  `idx_notification_log_status_sent_at`. See ADR-031 for the cadence,
  denominator, and test-strategy decisions.
- **E5 complete — Production Configuration & Operational Hardening
  (Pillars 1-4).** Pillar 1 (health endpoints + graceful shutdown):
  `GET /health` (always 200) and `GET /health/ready`
  (`apps/api/src/health/`, DB `SELECT 1` + Redis `PING`, 200/`ready` or
  503/`not_ready`) are deliberately unauthenticated — no `@UseGuards`,
  since no global auth guard exists in this repo. The ready/not-ready
  decision is a pure function (`readiness.util.ts`), unit-tested directly
  against db/redis ok/fail combinations. `apps/api`/`apps/worker` both
  gained explicit SIGTERM/SIGINT handlers with structured, PII-free
  logging; the API drains its HTTP server (stop new connections, finish
  in-flight requests, 30s cap) *before* closing the DB pool — NestJS's own
  `app.close()` runs `OnModuleDestroy` before closing the HTTP server
  (confirmed against `@nestjs/core`'s own source), which would otherwise
  fail requests still in flight during drain. Verified against the real
  production Docker images (`docker stop`, a genuine Linux SIGTERM — not
  emulable from this dev machine's Windows host) rather than assumed.
- Pillar 2 (production config + secret contract): `.env.production.example`
  (every env var the system actually reads, `CHANGE_ME` placeholders) and
  `infra/docker/docker-compose.production.yml` (built images, no dev
  deps/MailHog, resource limits + `restart: unless-stopped` everywhere,
  API healthcheck wired to `/health/ready`; Keycloak deliberately excluded
  — productionizing an identity provider is a distinct concern from this
  phase's four pillars). `packages/shared` gained a `SecretLoader`
  interface (`EnvSecretLoader`, wired everywhere today;
  `AwsSecretsManagerLoader`, an explicit not-implemented E6 stub — no
  `@aws-sdk` runtime dependency added). See ADR-032: whether PgBouncer's
  transaction pooling mode is safe with this repo's `SET LOCAL`-based
  tenant-context pattern was tested for real (`edoburu/pgbouncer` against
  this environment's live Postgres, 4 scenarios including 20 concurrent
  transactions) rather than assumed — zero cross-transaction leakage in
  every case.
- Pillar 3 (operational runbooks):
  `docs/runbooks/{deploy,rollback-migration,restart-worker,
  investigate-failed-notifications}.md`. Every copy-pasteable command was
  run for real against the live stack, which surfaced two real
  discrepancies from what a generic runbook assumed: no manual reminder
  re-scan HTTP endpoint exists anywhere in this repo (documented the real
  BullMQ-queue-enqueue mechanism instead, verified end-to-end); the real
  failure-observability endpoint is `GET /api/v1/notification-log/stats`
  (E4 Pillar 4), not a `/health`-style route. Also documented a genuine
  pre-existing gap: `infra/postgres/migrate.js` has no applied-migration
  tracking (no `schema_migrations` table) — it was only ever built to
  bootstrap a fresh database, not to apply new migrations incrementally
  against one that already has some applied.
- Pillar 4 (integration gate) closes out E5: 159/159 tests passing (71
  unit / 52 security / 36 integration), typecheck/lint clean, `npm audit
  --audit-level=high` exit 0 (6 pre-existing moderate findings only,
  ADR-019/ADR-027), all 5 CI jobs green on a real GitHub Actions run (PR
  #6). `E5_GATE.md` records the final state; tagged `e5-complete`.
- **E6 complete — Production Simulation & Scale Validation. Validation
  only: no features, no migrations.** Built `tools/seed/` (faker-based
  synthetic data, `@test.invalid` emails, batched multi-row INSERT under
  RLS — `npm run generate/cleanup/seed:users`, ADR-034/ADR-035) and
  `tools/load-tests/` (k6 v2.2.0 read-mix harness). Seeded 10K → 100K →
  300K → 500K and drove the API with k6; injected real infra failures;
  ran a `pg_dump`/`pg_restore` drill. Result: **every hot read path
  degrades linearly (never worse-than-linear)**; sustainable throughput
  scales ~1/n (~30 req/s at 100K → ~10 at 300K on the constrained
  validation host); `GET /dashboard/expiring` (O(limit)) and `/health*`
  (O(1)) stay flat. Five O(n) read paths + one resilience gap
  (`packages/database/src/index.ts` `createDb()` has no `pool.on('error')`
  → a Postgres restart or a single `pg_terminate_backend` on an idle
  connection crashes API **and** worker; masked in prod by the container
  `restart:` policy) are documented and scheduled for E7 — none is fixed
  here. Self-heals cleanly from Redis / Keycloak / SMTP / worker-crash
  failures. Backup/restore preserves and re-enforces RLS + FORCE RLS +
  the NULLIF guard + all `tenant_isolation_*` policies + the
  `audit_events` append-only grant (new `docs/runbooks/backup-restore.md`).
  ADR-036: the E6-introduced `@faker-js/faker` HIGH advisory (devDep,
  validation-tooling only) plus a pre-existing transitive `fast-uri` HIGH
  were remediated (faker → v10, `npm audit fix`) to keep the gate at
  E5's "zero HIGH/CRITICAL" bar. Full analysis:
  `docs/e6-results/E6_PERFORMANCE_REPORT.md`; `E6_GATE.md` records the
  final state; tagged `e6-complete`. Sustained-load capped at 300K (host
  RAM below the 8 GB floor all epoch); 1M deferred.
- **E7 complete — AWS Production Infrastructure (Staging Deployment).**
  First real cloud deployment, live at
  `https://compliance.ai-english-os.online` (EC2 t3.micro
  `i-0779afd8bafdedbc9`, RDS PostgreSQL 18.4 db.t3.micro Single-AZ, 5
  Secrets Manager secrets, Nginx + Let's Encrypt TLS, Keycloak 26.7.2
  self-hosted — no managed IdP). Region eu-west-1 (Ireland): the natural
  me-central-1/me-south-1 UAE-region targets were unavailable this epoch
  due to regional disruption (ADR-041 documents the migration path once
  they recover). Account runs on AWS's post-2025 Free Plan ($100 signup
  credit, ~3-month always-on runway at ~$30-35/month, not the legacy
  12-month Free Tier the original plan assumed) — deviations (`t3.micro`
  not `t2.micro`, backup retention 1 day not 7, DB name `e0db` not
  `compliance_db`) are all recorded live in ADR-041 as they were hit. 300
  synthetic employees / 704 documents seeded across the 5 E6 tenants
  (`infra/aws/seed-smoke-data.sh`, reusing E6's seed tooling unchanged); a
  full k6 smoke run against the real production URL passed 100% (60/60
  checks, 0% failed, avg 207ms / p95 379ms). Five real,
  previously-invisible bugs surfaced only by a genuine authenticated
  request through the real public domain — none visible to automated
  health checks alone: a `deploy-stack.sh` worker-log verification race, a
  CRLF-vs-LF checksum-pinning mistake, a
  `KEYCLOAK_ISSUER`/`KEYCLOAK_JWKS_URI` double-`https://` bug (every real
  JWT validation 401'd), Nginx never routing `/auth/realms/*` to Keycloak,
  and Nginx caching the `api` container's IP forever (every redeploy
  502'd until a manual Nginx restart) — all fixed live, see
  `E7_GATE.md`'s `bugsFoundAndFixedThisPhase`. ADR-041 records the full
  architecture/cost/least-privilege ruling; `docs/e7-results/` has the
  phase-by-phase detail. Tagged `e7-complete`.

  Known gaps carried out of E7 (`E7_GATE.md`'s `knownLimitations`):
  `DATABASE_URL` used `sslmode=no-verify` (encrypts without validating the
  RDS CA chain — acceptable only because the path never leaves the VPC),
  `audit_events.actorIp` recorded Nginx's own container IP not the real
  caller's, `infra/postgres/migrate.js` had no incremental-migration
  tracking, SMTP delivery was never live-tested against the real
  `compliance/prod/smtp` provider, and the 5 O(n) read paths E6 flagged
  were untouched (infrastructure standup, not application performance
  work).

  **All but two since resolved as standalone post-E7 fixes, merged into
  `main` the same day this branch merged:** ADR-037 (`pool.on('error')`
  resilience fix, landed just ahead of E7), ADR-038 (`schema_migrations`
  tracking — the live RDS database backfills its ten already-applied
  migrations as already-tracked on first run, no re-execution), ADR-039
  (`app.set('trust proxy', 1)` — `audit_events.actorIp` now records the
  real client IP, live-verified against production: a real request from a
  known external IP produced an `audit_events` row with that exact IP,
  not a container address), and ADR-040 (4 newly-surfaced HIGH `npm
  audit` findings — multer/nodemailer/js-yaml — remediated). Both
  `compliance-api` and `compliance-worker` images were rebuilt from
  `main` and redeployed to the live EC2 host to take effect.

  **A fifth post-E7 standalone fix closes 3 of E6's 5 O(n) read-path
  findings**: `packages/database/migrations/011_post_e7_read_path_indexes.sql`
  adds `idx_documents_employee` (fixes `GET /employees/:id/documents`),
  a composite `btree_gin` `idx_employees_search_tenant` replacing the
  never-chosen plain-GIN `idx_employees_search` (fixes `GET
  /employees?q=`), and `idx_employees_list` on `(tenant_id, created_at)`
  (fixes `GET /employees?page=N`'s sort). Purely additive: no RLS, grant,
  or application-code change. See ADR-042. Backlog item 4 (a
  `document_status_rollup` for `dashboard/summary`/`document-stats`) is
  explicitly deferred — `tools/seed/generate.ts` inserts into `documents`
  directly, bypassing `DocumentsService`, so app-level rollup maintenance
  would silently drift during exactly the seed-scale scenario this backlog
  targets; needs its own design decision (trigger vs. app-level).

  Still open: a live SMTP delivery test against the real provider (blocked
  on `compliance/prod/smtp` still holding `CHANGE_ME` placeholders — no
  provider has been chosen yet), and backlog item 4 above.

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
- Current state: 183/183 passing (95 unit / 52 security / 36 integration)
  — the unit count rose 71 → 90 with the ADR-033 calendar-days assertions
  (commit `1c309b7`, pre-E6); E6 added no tests (validation-only); 90 → 91
  with ADR-037's `pool.on('error')` listener-registration test, a
  pre-existing drift this line hadn't caught up to until ADR-039 measured
  it fresh; 91 → 95 with ADR-038's `planMigrations()` coverage
  (`tests/unit/migrate-plan.test.ts`)
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
