# Architecture Decision Log

Chronological record of every deviation from, clarification of, or addition to
CLAUDE.md/the task spec, for both E0 and E1. Per the Security Gates rule,
anything touching RLS, auth, or tenant isolation is documented here before
implementation.

## ADR-001: Postgres 18 data directory convention

Date: E0
Status: ACCEPTED
Context: `postgres:18-alpine` refuses to start with a volume mounted at
`/var/lib/postgresql/data` (its pre-18 convention) -- 18+ expects a single
mount at `/var/lib/postgresql` and places data in a major-version
subdirectory.
Decision: `docker-compose.yml` mounts the named volume at `/var/lib/postgresql`.
Consequences: Pure Docker plumbing, no behavioral change.

## ADR-002: `migration_user` needs `CREATE` on `public`

Date: E0
Status: ACCEPTED
Context: Postgres 15+ revokes `CREATE` on the `public` schema from `PUBLIC` by default.
Decision: `001_roles.sql` explicitly grants `USAGE, CREATE ON SCHEMA public TO
migration_user` (and `USAGE` to `app_user`) so `002_schema.sql`'s
`SET ROLE migration_user; CREATE TABLE ...` succeeds.
Consequences: migration_user ends up owning the tables, per spec.

## ADR-003: RLS policy NULLIF guard against the `''` vs `NULL` gap

Date: E0
Status: ACCEPTED
Context: Empirically verified against Postgres 18: a custom placeholder GUC
(`app.current_tenant_id`) set via `SELECT set_config(name, value, true)`
(`SET LOCAL` semantics) with no prior session-level value reverts to `''`
(empty string) on COMMIT, not `NULL`. A bare `current_setting(...) IS NOT
NULL` guard lets `''` through, and the subsequent `::uuid` cast then throws
instead of the query cleanly returning zero rows. Fail-closed either way --
no tenant's data is ever returned; this is a robustness gap, not a
cross-tenant leak or "context leaks between requests" stop condition.
Decision: Wrap `current_setting(...)` in `NULLIF(..., '')` in both the `IS
NOT NULL` guard and the cast, in all three RLS policies (`003_rls.sql`).
Consequences: `''` and true `NULL` behave identically -- 0 rows, no error, in
both "never set" and "reset after commit" cases. Strict robustness
improvement; does not weaken the tenant-match requirement. In practice this
edge case never reaches application code, since every transaction that
touches RLS-protected tables sets tenant context as its first statement.

## ADR-004: Keycloak OTP secret is raw UTF-8 bytes, not Base32-decoded

Date: E0
Status: ACCEPTED
Context: Empirically verified against Keycloak 26.7.2: `OTPCredentialModel`
does not Base32-decode the stored `secretData.value` before using it as the
HMAC-SHA1 key -- it uses the secret string's raw UTF-8 bytes directly. This
differs from the RFC 6238 reference behavior most TOTP libraries assume.
Decision: `tests/support/totp.ts` and `tests/load/baseline.js` both implement
raw-bytes HMAC keying to match.
Consequences: Only affects test/load-test tooling that mints tokens
programmatically; has no bearing on `apps/api/src/auth/jwt.strategy.ts`,
which only verifies already-issued JWTs.

## ADR-005: Keycloak single-use TOTP codes

Date: E0
Status: ACCEPTED
Context: Keycloak rejects a TOTP code already consumed within its 30-second
window, even across independent logins.
Decision: `tests/support/totp.ts` exports `nextTotp()`, which tracks the last
consumed window (persisted to `tests/support/.totp-state.json`, gitignored)
and waits for the next window if the current one was already used.
`tests/load/baseline.js` uses a bounded retry-with-30s-sleep for the same
reason.
Consequences: Auth/pooling test suites can take up to ~30s longer than
expected when consecutive TOTP logins land in the same window.

## ADR-006: Keycloak default User Profile requires firstName/lastName

Date: E0
Status: ACCEPTED
Context: With no `firstName`/`lastName` set, direct-grant login fails with
`invalid_grant` regardless of `requiredActions`/`emailVerified` -- Keycloak
26's default declarative User Profile enforces this dynamically at login.
Decision: `infra/docker/keycloak/realm-export.json` sets synthetic
`firstName`/`lastName` for all 4 test users.

## ADR-007: Keycloak token endpoint returns 400, not 401, for invalid_grant

Date: E0
Status: ACCEPTED
Context: Per OAuth2 (RFC 6749 §5.2), the token endpoint returns 400 with
`{"error": "invalid_grant"}` for bad credentials / disabled accounts -- never
401 (401 is reserved for the resource server, i.e. our own API, rejecting a
bad _token_).
Decision: `tests/integration/keycloak.test.ts` asserts 400 + `invalid_grant`
for KC-02/KC-05, matching real Keycloak/OAuth2 behavior.

## ADR-008: Keycloak issuer (`iss`) reflects the request's Host header

Date: E0
Status: ACCEPTED
Context: By default, Keycloak dev-mode's `iss` claim reflects whatever Host
header reached it. A token requested via `host.docker.internal:8080` would
carry a different `iss` than `KEYCLOAK_ISSUER`, causing an otherwise-valid
token to be rejected -- correctly, since accepting a token whose issuer
doesn't match a fixed configured issuer would be an issuer-confusion
vulnerability.
Decision: Pin Keycloak's effective issuer with `KC_HOSTNAME=localhost` /
`KC_HOSTNAME_STRICT=false` in `infra/docker/docker-compose.yml`.

## ADR-009: TenantMiddleware is a Guard, not Express middleware

Date: E0
Status: ACCEPTED
Context: The mandated flow is `AuthGuard -> Organization Extractor -> Tenant
Resolver -> ...`, strictly in that order. NestJS runs all middleware before
any guard regardless of registration order, which would break this ordering
if tenant resolution were real `NestMiddleware` -- it would run before the
JWT was verified.
Decision: `apps/api/src/tenant/tenant.middleware.ts` implements `CanActivate`
and is applied via `@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)`,
which Nest executes strictly in array order. `tenant.resolver.ts` holds the
DB lookup and is unaffected.

## ADR-010: PerfController's raw-query endpoint deliberately uses migration_user

Date: E0
Status: ACCEPTED
Context: Measuring RLS overhead (PERF-01 vs PERF-02) requires a query that
bypasses RLS entirely.
Decision: `GET /api/v1/perf/raw-query` is the one sanctioned exception to
"never use migration_user in application code." Hard-gated to
`NODE_ENV=test` (403 otherwise), reachable by no other code path.

## ADR-011: Files added beyond the literal spec'd directory tree

Date: E0
Status: ACCEPTED
Context: `rbac/rbac.module.ts`, `rbac/test.controller.ts`, `perf/perf.module.ts`,
and shared test helpers weren't named in the original file tree, but are
required to satisfy explicit requirements elsewhere in the spec.
Decision: Kept, as no scope beyond what's explicitly required was added.

## ADR-012: Migrations run via SQL init files, not drizzle-kit push/migrate

Date: E0
Status: ACCEPTED
Context: `002_schema.sql` (executed by migration_user at container init) is
the schema's source of truth.
Decision: `packages/database/src/schema.ts` mirrors it for type-safe Drizzle
queries; `apps/api/drizzle.config.ts` exists only so drizzle-kit can
introspect/typecheck during development. No `drizzle-kit push`/`migrate` is
ever run against the database.

---

## ADR-013: RBAC role hierarchy centralized in @ecs/shared

Date: E1
Status: ACCEPTED
Context: E0's `rbac.guard.ts` duplicated the role ordering as a local
`HIERARCHY` array (`indexOf`-based comparison). E1 introduces
`packages/shared` as the canonical home for cross-app constants.
Decision: Moved the role hierarchy into `packages/shared/src/constants/roles.constants.ts`
as `ROLE_HIERARCHY` (a `Record<Role, number>`, 1=viewer..5=platform-admin).
`apps/api/src/rbac/rbac.guard.ts` now compares numeric levels from
`ROLE_HIERARCHY` instead of array `indexOf`.
Consequences: Verified equivalent security semantics to E0: an unrecognized
role still evaluates to the lowest possible level (0, via `?? 0`) and is
rejected exactly as `indexOf(...) === -1` was in E0. This is a refactor only
-- no change to which roles can access which endpoints.

## ADR-014: ESLint flat config instead of `.eslintrc.js`

Date: E1
Status: ACCEPTED
Context: `eslint@latest` resolves to ESLint 9+, whose default config format is
flat config; `.eslintrc.js` requires opting back into the legacy system
(removed entirely in ESLint 10).
Decision: `eslint.config.mjs` at the repo root, using `typescript-eslint`'s
strict+stylistic configs, `eslint-plugin-security`, and
`eslint-config-prettier` for Prettier integration -- same intent as
originally specified, different (more future-proof) mechanism.

## ADR-015: CI test-security job applies migrations explicitly

Date: E1
Status: ACCEPTED
Context: Local dev (`infra/docker/docker-compose.yml`) mounts
`infra/postgres/init` as `docker-entrypoint-initdb.d`, which Postgres runs
automatically on first boot of an empty volume. GitHub Actions `services:`
containers don't support mounting local repo files this way, so a bare
`postgres:18-alpine` service starts with no roles/schema/RLS/seed data at all.
Decision: Added `infra/postgres/migrate.js` (superuser-only, never
app_user/migration_user) that applies `packages/database/migrations/*.sql`
in order, and a step in `.github/workflows/ci.yml`'s `test-security` job that
runs it before `npm run test:security`. Also scoped
`.github/workflows/security.yml`'s `dependency-review` job to
`pull_request` events only, since `dependency-review-action` diffs a base
against a head ref and has nothing to compare on `schedule`/`push`.

## ADR-016: BullMQ workers extracted into a standalone apps/worker process

Date: E1
Status: ACCEPTED
Context: E0's workers ran inside the same NestJS process as the API
(`app/src/workers/`), via `WorkersModule`. E1's monorepo structure specifies
`apps/worker` as a separate process.
Decision: `createReminderWorker`/`createImportWorker` now take a Drizzle
`Database` handle directly (from `@ecs/database`) instead of NestJS's
`DrizzleService`, since the worker process has no Nest DI container.
`apps/worker/src/main.ts` constructs its own pool/db (app_user only) and
Redis connection, and handles `SIGTERM`/`SIGINT` for graceful shutdown.
Consequences: `apps/api/src/app.module.ts` no longer imports `WorkersModule`.
Job schemas, tenant-context-per-transaction, and idempotency-key
deduplication logic are otherwise unchanged from E0.

## ADR-019: drizzle-orm, drizzle-kit, and vitest bumped for CVE fixes

Date: E1
Status: ACCEPTED
Context: `npm install` with the originally-pinned versions (drizzle-orm
^0.36.4, vitest ^2.1.8) surfaced 1 critical (vitest <3.2.6, arbitrary file
read/execute via the Vitest UI server, GHSA-5xrq-8626-4rwp), 2 high
(drizzle-orm <0.45.2 SQL injection via improperly escaped identifiers,
GHSA-gpj5-g38j-94v9; vite <=6.4.2 path-traversal, GHSA-fx2h-pf6j-xcff, pulled
in transitively by vitest), and 6 moderate `npm audit` findings. The E1 spec
requires `npm audit` to pass with zero high/critical before the first commit.
Decision: Bumped `drizzle-orm` to `^0.45.2` (root, `apps/api`, `apps/worker`,
`packages/database`), `drizzle-kit` to `^0.31.10` (`apps/api`, dev-only), and
`vitest` to `^4.1.11` (root). Re-ran `npm audit --audit-level=high` (the same
gate CI uses) after the bump: exit 0, zero high/critical.
Consequences: 4 moderate findings remain, all from `drizzle-kit`'s
transitive `@esbuild-kit/*` dependency (esbuild dev-server request
smuggling, GHSA-67mh-4wv8-2f99). `drizzle-kit` is dev-tooling only --
used solely by `apps/api/drizzle.config.ts` for local schema
introspection/typecheck (ADR-012), never invoked in CI or at runtime -- so
this is accepted as a documented residual risk rather than force-downgrading
`drizzle-kit` (npm's suggested "fix" for it is actually a downgrade to
0.18.1, which is not a real fix). Revisit when `drizzle-kit` ships a release
off the vulnerable esbuild-kit chain.

## ADR-017: packages/database exports a shared `createDb()` connection factory

Date: E1
Status: ACCEPTED
Context: Both `apps/api`'s `DrizzleService` and `apps/worker`'s `main.ts` need
to construct a `pg.Pool` + Drizzle instance from a connection string.
Decision: `packages/database/src/index.ts` exports `createDb(config: PoolConfig)`,
so there is exactly one place that owns "how we connect to Postgres with
Drizzle." Callers still supply their own credentials -- this never assumes
app_user vs. migration_user.

---

## ADR-020: Audit-write transaction consistency — SAVEPOINT pattern

Date: E2
Status: ACCEPTED

Context: The E2 task spec's Audit Trail phase places two requirements on
`AuditService.log()` that cannot both hold under plain Postgres transaction
semantics: (a) it must run "inside the same DB transaction as the business
operation," and (b) "audit failure must NOT rollback the business
transaction" (never throw; log and continue). Once *any* statement inside a
transaction raises a SQL-level error -- e.g. the `audit_events` INSERT trips
its `outcome` CHECK constraint, a connection blip, disk pressure, anything --
Postgres marks the whole transaction ABORTED. Every subsequent statement on
that same transaction, including the business INSERT/UPDATE that already ran
and the final COMMIT, is then rejected ("current transaction is aborted,
commands ignored until end of transaction block") regardless of whether the
JS-level `try/catch` swallows the original error. So a literal reading --
"insert the audit row inside the caller's `tx`; catch and ignore failures" --
is not implementable: either the poisoned transaction dooms the business
write too (violating "must not rollback"), or the audit write has to move
outside the transaction (breaking "same transaction," and reopening exactly
the gap that CLAUDE.md's "NEVER skip audit logging for write operations"
rule exists to close). This is a real architectural contradiction in the
spec, not an implementation detail -- flagging and resolving it here per the
Review Gates rule, before writing `audit.service.ts`.

Decision: `AuditService.log()` wraps its INSERT in a Postgres `SAVEPOINT`
scoped to the caller's transaction:
1. `SAVEPOINT audit_write`
2. `INSERT INTO audit_events (...)`
3. success -> `RELEASE SAVEPOINT audit_write`
4. failure -> `ROLLBACK TO SAVEPOINT audit_write`, log a structured `ERROR`
   line with no PII (`action`, `entityType`, `entityId` first 8 chars,
   `tenantId` first 8 chars, `outcome`, error message only), and return
   normally -- never re-throws into the caller.

The audit write stays inside the same outer transaction as the business
operation, so on the success path (the overwhelming majority of calls) the
audit row and the business row commit or roll back together, atomically --
which is what "same transaction" is actually for. On the rare path where the
audit INSERT itself fails, the SAVEPOINT contains the damage: rolling back to
it clears the aborted state on just that sub-scope, so the outer transaction
is healthy again and the business operation's own statements can still
commit normally. This is the standard Postgres idiom for "a step that must
not be allowed to poison an outer transaction."

Consequences:
- Business integrity: never blocked or rolled back by an audit-only failure
  -- satisfies "audit failure must NOT rollback business transaction"
  literally (at the Postgres transaction-state level), not just via a JS
  `try/catch` that turns out not to matter.
- Audit integrity: atomic with the business write on the success path (no
  separate-transaction gap between "business committed" and "audit
  durable"); best-effort (loudly logged, not silently dropped) on the one
  failure mode -- the audit INSERT itself erroring -- that is mathematically
  impossible to reconcile with "must not roll back the business op." This is
  a deliberate, documented weakening of "NEVER skip audit logging," not a
  silent one: every audit-write failure is logged at ERROR level with enough
  context (action/entityType/entityId prefix/tenantId prefix/outcome) to be
  found and reconciled, and the business row's own `version`/timestamps still
  provide a partial trail even without the `audit_events` row.
- Residual risk: E2 does not wire alerting on the "audit write failed" log
  line (no notification/alerting system is in E2's scope). Until that exists,
  an audit-write failure is discoverable only by log inspection, not
  proactively paged. Recorded as a known gap for E3, not resolved silently.
- No new tables, background jobs, or outbox/retry workers introduced --
  respects E2's explicit scope prohibition on background job scheduling.

Alternatives considered:
- *Audit as a hard dependency* (audit INSERT fails -> whole tx fails ->
  business op fails too): rejected -- directly violates the spec's explicit
  "must NOT rollback" requirement.
- *Audit in a separate transaction/connection after business commit*:
  rejected for E2 -- reintroduces a real gap between business-commit and
  audit-durability with no async retry mechanism allowed in scope to close
  it, and loses same-transaction atomicity on the success path for no
  benefit over the SAVEPOINT approach.
- *Outbox table + background worker for guaranteed eventual audit delivery*:
  rejected for E2 -- explicitly out of scope ("Do NOT build: ... Background
  job scheduling"). Revisit in E3 if audit-write failures prove
  non-negligible in practice.

## ADR-021: `full_name` retained as a derived column alongside `first_name`/`last_name`

Date: E2
Status: ACCEPTED

Context: E0's `employees.full_name` is `NOT NULL` and is what E0's RLS/seed
tests already depend on. The E2 spec's `CreateEmployeeDto` only carries
`firstName`/`lastName` (no `fullName`), and the E2 migration rules mandate
additive-only schema changes -- `006_employees_extended.sql` adds
`first_name`/`last_name` as nullable columns without touching `full_name`.
Dropping or relaxing `full_name`'s `NOT NULL` would be a legitimate additive
migration (loosening a constraint breaks nothing) and would let the E2 API
skip it, but it is unmentioned in the spec and existing E0 seed rows/tests
already treat `full_name` as the display identity.
Decision: `EmployeesService.create()` computes `full_name =
`${firstName} ${lastName}`.trim()` and writes it alongside the new
`first_name`/`last_name` columns. `full_name` remains the E0-compatible
display column (still `NOT NULL`, still what `RLS-01` etc. assert against);
`first_name`/`last_name` are the new authoritative structured fields the E2
API reads/writes going forward. E0 seed rows keep `full_name` populated with
`first_name`/`last_name` left `NULL`, which is valid since those columns are
nullable.
Consequences: One redundant derived column during the E0->E2 transition
instead of a breaking schema change to `full_name`'s nullability that the
spec never asked for. No behavioral risk -- `full_name` is write-only-derived,
never independently editable via the E2 API.

## ADR-022: Request-ID generation is Express middleware, not a NestJS Interceptor

Date: E2
Status: ACCEPTED

Context: The E2 spec sketches request-ID generation as
`apps/api/src/interceptors/request-id.interceptor.ts`. NestJS Interceptors
only run *after* a route's Guards have already passed (pipeline order:
Middleware -> Guards -> Interceptors -> Pipes -> Handler). A request rejected
by `AuthGuard`/`TenantMiddleware`/`RbacGuard` (401/403) would therefore never
reach an Interceptor, so `HttpExceptionFilter` would have no `requestId` to
attach to the large majority of error responses -- exactly the responses
where a correlatable ID matters most for support/debugging. This is the same
class of pipeline-ordering issue ADR-009 already resolved for
`TenantMiddleware`, just in the opposite direction (that one needed to run
*after* a Guard it looks like Express middleware; this one needs to run
*before every* Guard).
Decision: `apps/api/src/common/request-id.middleware.ts` implements real
`NestMiddleware`, applied via `AppModule.configure()` to `'*'` -- runs before
all Guards, so `requestId`/`correlationId` are always present, including on
every 400/401/403/404/409/500 response. No `interceptors/` directory was
created since there's no post-handler response transform in scope for E2.
Consequences: Purely a request-plumbing/observability decision -- does not
touch RLS, auth, or tenant-isolation logic. `X-Correlation-ID` is honored
from the incoming request header if present (for cross-service tracing),
otherwise generated.

## ADR-023: `test:unit` added to CI; HTTP+Keycloak-dependent tests remain CI-gapped (pre-existing, not E2-introduced)

Date: E2
Status: ACCEPTED

Context: E2 adds `tests/unit/**` (pure-logic tests: Expiry Engine, AuditService
with a mocked transaction, EmployeesService with a mocked Drizzle handle --
no DB, no Keycloak, no running API). `.github/workflows/ci.yml`'s only test
job (`test-security`) provisions Postgres + Redis but not Keycloak, and never
boots the API server as a background process. That gap already existed
before E2: E0's own `tests/security/rbac.test.ts` and
`tests/integration/keycloak.test.ts` require a live API + Keycloak and are
not actually exercised by the committed CI config today -- discovered while
validating E2's own new HTTP-dependent tests (`tests/security/rbac-e2.test.ts`,
`tests/security/optimistic-locking.test.ts`, all of `tests/integration/`)
against a local `docker compose` stack, where two real bugs surfaced that a
CI run would also have caught: (1) `EmployeesService`'s unique-violation
detection only checked `err.code`, not drizzle-orm's `DrizzleQueryError.cause.code`
(the actual driver error is wrapped, not thrown directly) -- duplicate
employee_code was returning 500 instead of 409; (2) E2's own security-suite
files that create real employees via the API (`optimistic-locking.test.ts`,
`rbac-e2.test.ts`) were never cleaning them up, which -- because
`fileParallelism: false` runs every file in `tests/security/**` in one
process against one database -- silently drifted E0's `rls.test.ts` exact
row-count assertions (RLS-01 expects 5, RLS-06 expects 15) on every run
after the first, in CI exactly as much as locally.
Decision: (1) Fixed both bugs (see `employees.service.ts`'s `isUniqueViolation`,
and `tests/support/db-cleanup.ts` + `afterAll` hooks in every E2 test file
that creates real employees). (2) Added a `test-unit` CI job (`.github/workflows/ci.yml`)
-- cheap, no services required. (3) Did NOT build out Keycloak-in-CI wiring
for `test-security`/a new `test-integration` job -- that is materially new CI
infrastructure (GitHub Actions `services:` containers can't mount local files
the way `docker compose`'s `docker-entrypoint-initdb.d` does, so importing
`realm-export.json` in CI needs its own solution, mirroring the
already-solved-differently `infra/postgres/migrate.js` problem from ADR-015),
which is out of E2's stated scope (four MVP capabilities, not CI
infrastructure) and predates E2.
Consequences: `test:unit` is now genuinely CI-verified on every push/PR.
`test:security`/`test:integration`'s HTTP+Keycloak-dependent tests (both E0's
and E2's) remain verified only via local `docker compose up` + manually
running the API/worker processes, exactly as they were before E2 -- not a
regression, but not fixed either. Recorded here so it isn't mistaken for
"E2 wired up full CI test coverage" -- it did not. Risk carried into E3 (or a
dedicated CI-infrastructure task) as a known gap.

## ADR-024: CI closes the ADR-023 gap via `docker compose` on the runner, not GitHub Actions `services:`

Date: E3
Status: ACCEPTED

Context: ADR-023 left `test:security`'s HTTP+Keycloak-dependent tests and all
of `test:integration` CI-unenforced, because GitHub Actions `services:`
containers can't bind-mount local files the way `docker compose`'s
`docker-entrypoint-initdb.d` (Postgres) and realm-import (Keycloak) volume
mounts do. Closing this gap is E3 Pillar 1's stated goal. The fix does not
require new CI infrastructure: GitHub-hosted `ubuntu-latest` runners ship
Docker Engine and the Compose v2 plugin already, so `docker compose -f
infra/docker/docker-compose.yml -f infra/docker/docker-compose.test.yml up
-d` run as a plain step in a job works identically to local dev -- local
files bind-mount normally because it's the same `docker compose` CLI, not
GitHub's `services:` feature. This sidesteps the ADR-015/ADR-023 limitation
entirely rather than working around it.

Decision:
1. `.github/workflows/ci.yml` is restructured into 5 sequentially-gated jobs
   (`lint -> unit-tests -> integration -> security-scan -> build`, chained
   via `needs:`, so a failure stops the pipeline before the next stage
   starts). `integration` brings up the full stack via `docker compose`,
   waits on each container's healthcheck (`docker inspect
   .State.Health.Status`, not `docker compose ps --format`, whose Go-template
   fields aren't stable across Compose versions), starts `apps/api` and
   `apps/worker` as background processes, waits for the API to respond, then
   runs `test:security` and `test:integration` together -- both need the same
   live stack, so splitting them into separate jobs would just duplicate the
   docker-compose bring-up cost for no isolation benefit.
2. Fixed a real, latent bug in `infra/docker/docker-compose.test.yml`
   surfaced by actually validating it (`docker compose config`) for the first
   time: it declared a top-level `tmpfs: [/var/lib/postgresql]` on the
   `postgres` service *alongside* the base file's named-volume mount at the
   same target -- two mounts claiming one path, which Compose rejects. This
   was never caught before E3 because, per ADR-023, the integration path
   this override exists for was never actually exercised end-to-end. Fixed by
   redefining the `postgres_data` named volume itself with a tmpfs
   `driver_opts` (RAM-backed, still ephemeral) instead of adding a competing
   `tmpfs:` mount -- the base file's single `volumes:` mount to
   `/var/lib/postgresql` is unchanged, only what backs it differs.
3. Added `internal: true` + per-service `deploy.resources.limits` to the same
   override, so the CI/local test stack can't reach (or be reached from)
   anything beyond the containers/host it's for. `internal: true` blocks
   container-initiated egress; published ports (5432/6379/8080) are
   unaffected since port publishing is independent of a network's internal
   flag -- host/CI-runner access to the containers still works, which is all
   the test suites need.
4. `security-scan` runs `npm audit --audit-level=high` (as before) plus
   `trivy fs` (dependency/filesystem scan) instead of a container-image scan.
   No Dockerfile or built image exists anywhere in this repo yet -- per
   `docs/architecture/threat-model.md`'s "no production deployment topology"
   scope note -- so there is no image for Trivy to scan. `trivy fs` is the
   applicable equivalent today; an image scan (and `hadolint`, which lints
   Dockerfiles that also don't exist) should be added when a Dockerfile is
   introduced in a later phase, not stubbed out now.
5. `.github/workflows/security.yml`'s schedule moved from weekly (Monday
   06:00) to daily 02:00 UTC. Added a conditional Snyk job that no-ops rather
   than hard-fails since no Snyk token is provisioned in this environment
   today, and a full-repository TruffleHog scan (`extra_args:
   --only-verified`, no `base`/`head`) for the `schedule` trigger, which has
   no meaningful diff to compare -- `ci.yml`'s own TruffleHog step already
   covers the diff-based push/PR case. The Snyk no-op condition could not be
   written as `if: secrets.SNYK_TOKEN != ''` on the job, nor (initially
   assumed as the fix) on the step either -- `secrets` cannot be referenced
   directly in an `if:` expression at any level. Confirmed empirically on
   this branch's own CI runs: both attempts produced "Invalid workflow file:
   Unrecognized named-value: 'secrets'" (zero jobs scheduled for the whole
   workflow). The working pattern checks the secret's presence inside a
   `run:` step instead (`secrets.X` is valid there, and in `env:`/`with:`),
   writes a `steps.<id>.outputs` boolean, and conditions the actual Snyk step
   on that output -- never on `secrets` directly.
6. Branch protection (PR required, all 5 `ci.yml` jobs required, 1 approving
   review, no force-push) is documented in `CONTRIBUTING.md`. This is a
   GitHub repo *setting*, not a file in this repo, so it can't be verified by
   `git log`/tests -- it has to be configured once in GitHub's UI/API by
   someone with admin access to the repo, and `CONTRIBUTING.md` is the
   auditable record of what that configuration should be.

Consequences: `test:security` and `test:integration`'s full 85-test surface
(minus `test:unit`, already covered since ADR-023) is now exercised in CI on
every push/PR, closing the gap ADR-023 left open. The pipeline is now fully
sequential rather than parallel, trading CI wall-clock time (each stage waits
for the previous one) for a stricter gate -- acceptable here since merge
safety, not CI speed, is what Pillar 1 was scoped to fix. Full end-to-end
verification of this workflow (as opposed to local config validation) needs a
real GitHub Actions run, since GitHub-hosted runner behavior can't be fully
replicated by running `docker compose` against this environment's own
already-running dev containers (port/project-name collisions) -- see the E3
final report for what was and wasn't verified locally versus in CI.
