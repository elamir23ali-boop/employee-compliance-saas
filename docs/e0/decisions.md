# E0 Decision Log

Chronological record of every deviation from, clarification of, or addition to the
CLAUDE.md/task spec, and every non-obvious finding discovered while building E0.
Per the Security Gates rule, anything touching RLS, auth, or tenant isolation is
documented here.

## 1. Postgres 18 data directory convention

`postgres:18-alpine` refuses to start with a volume mounted at
`/var/lib/postgresql/data` (its pre-18 convention) -- 18+ expects a single
mount at `/var/lib/postgresql` and places data in a major-version
subdirectory. `docker-compose.yml` mounts the named volume at
`/var/lib/postgresql`. No behavioral change, pure Docker plumbing.

## 2. `migration_user` needs `CREATE` on `public`

Postgres 15+ revokes `CREATE` on the `public` schema from `PUBLIC` by
default. `01_roles.sql` explicitly grants `USAGE, CREATE ON SCHEMA public TO
migration_user` (and `USAGE` to `app_user`) so `02_schema.sql`'s
`SET ROLE migration_user; CREATE TABLE ...` succeeds and migration_user ends
up owning the tables, per spec.

## 3. RLS policy: `NULLIF` guard against the `''` vs `NULL` gap (found by POOL-01)

**Finding:** empirically verified against Postgres 18 (`docker compose exec
postgres psql ...`): a custom placeholder GUC (`app.current_tenant_id`) that
is set via `SELECT set_config(name, value, true)` (`SET LOCAL` semantics)
inside a transaction, and had **no prior session-level value**, reverts to
`''` (empty string) on COMMIT -- not `NULL`. `current_setting(name, true)`
after that COMMIT returns `is_null = false`, `value = ''`.

The RLS policy text given in the original spec was:
```sql
USING (current_setting('app.current_tenant_id', true) IS NOT NULL
  AND tenant_id = current_setting('app.current_tenant_id', true)::uuid)
```
Because `''` `IS NOT NULL` is true, this evaluates the second clause and
`''::uuid` throws `invalid input syntax for type uuid`. A query issued on a
pooled connection that previously had tenant context set, but doesn't set it
again before querying, therefore gets a hard SQL **error**, not the 0-row
result POOL-01 specified.

**Severity assessment:** this is NOT a cross-tenant leak and NOT the
"context leaks between requests" stop condition -- no tenant's data is ever
returned; the failure mode is fail-closed (a thrown error blocks the query
entirely). It does not trigger a CRITICAL STOP. It's a robustness gap: an
error instead of a clean empty result.

**Fix applied** (`postgres/init/03_rls.sql`): wrap `current_setting(...)` in
`NULLIF(..., '')` in both the `IS NOT NULL` guard and the cast, so `''` and
true `NULL` behave identically -- 0 rows, no error, in both "never set" and
"reset after commit" cases. This is a strict robustness improvement; it does
not weaken the tenant-match requirement.

In practice this edge case never reaches application code: `employees.service.ts`
and both workers always call `set_config` as the very first statement of
every transaction, so a transaction with no context set never happens outside
this specific test scenario. Documented per the Security Gate on RLS changes.

## 4. Keycloak OTP secret: raw UTF-8 bytes, not Base32-decoded

**Finding:** empirically verified against Keycloak 26.7.2: `OTPCredentialModel`
does **not** Base32-decode the stored `secretData.value` before using it as
the HMAC-SHA1 key. It uses the secret string's raw UTF-8 bytes directly. This
differs from the RFC 6238 reference behavior most TOTP libraries (and
authenticator apps) implement, which assumes a Base32 secret.

Verified by: generating a code from `JBSWY3DPEHPK3PXP` both ways (Base32-decoded
per RFC 6238, and as raw UTF-8 bytes) and testing each against a live
Keycloak `password` grant with `totp=<code>`. The RFC 6238 (decoded) version
was rejected (`invalid_grant`); the raw-bytes version was accepted.

`test-support/totp.ts` and `load-tests/baseline.js` both implement raw-bytes
HMAC keying to match. This only affects test/load-test tooling that mints
tokens programmatically -- it has no bearing on `auth.guard.ts`, which only
verifies already-issued JWTs and never generates or checks TOTP codes itself.

## 5. Keycloak single-use TOTP codes

**Finding:** Keycloak rejects a TOTP code that has already been consumed
within its 30-second window (replay protection), even for the *same* code
value reused in a second, independent login. A test suite that logs in the
same TOTP user multiple times within ~30s of each other will intermittently
get `invalid_grant` on the second attempt if both attempts land in the same
window.

**Fix:** `test-support/totp.ts` exports `nextTotp()`, which tracks the last
TOTP time-window actually consumed (persisted to
`test-support/.totp-state.json` so it's shared across Vitest's per-file
isolated module instances, not just in-process) and waits for the next
window to roll over if the current one was already used. `load-tests/baseline.js`
uses a bounded retry-with-30s-sleep for the same reason, since separate `k6
run` invocations have no shared state at all.

## 6. Keycloak default User Profile requires `firstName`/`lastName`

**Finding:** with no `firstName`/`lastName` set, direct-grant login for an
otherwise-correctly-configured user (`requiredActions: []`, `emailVerified:
true`, correct password) fails with `invalid_grant` / "Account is not fully
set up". Keycloak 26's default declarative User Profile marks `firstName`
and `lastName` as required, and enforces this dynamically at login time
regardless of the stored `requiredActions` list. `keycloak/realm-export.json`
sets synthetic `firstName`/`lastName` for all 4 test users.

## 7. Keycloak token endpoint returns 400, not 401, for `invalid_grant`

The original test spec (KC-02, KC-05) expected Keycloak's token endpoint to
return HTTP 401 for a wrong password / disabled account. Per OAuth2 (RFC
6749 §5.2), the token endpoint returns **400** with `{"error":
"invalid_grant"}` for any bad-credentials case -- it never returns 401 here
(401 is reserved for the resource server, i.e. our own API, rejecting a bad
*token*, which is what KC-03/KC-04 correctly test). `auth-tests/keycloak.test.ts`
asserts 400 + `error === 'invalid_grant'` for KC-02/KC-05, matching actual,
documented Keycloak/OAuth2 behavior rather than the originally assumed status
code.

## 8. Keycloak issuer (`iss`) reflects the request's Host header

**Finding:** by default, Keycloak's dev-mode `iss` claim reflects whatever
Host header the token request used to reach it. A token requested via
`host.docker.internal:8080` (e.g. from k6 running inside a Docker container)
carries `iss: http://host.docker.internal:8080/realms/e0-test`, which does
not equal `KEYCLOAK_ISSUER` (`http://localhost:8080/realms/e0-test`) that
`auth.guard.ts` validates against -- causing an otherwise 100%-valid token to
be rejected as 401 "Invalid or expired token". This is not a bug in the
guard: accepting a token whose issuer doesn't match a fixed, configured
issuer would be a real vulnerability (issuer confusion). Fix: pin Keycloak's
effective issuer with `KC_HOSTNAME=localhost` / `KC_HOSTNAME_STRICT=false` in
`docker-compose.yml`, so `iss` is deterministic regardless of which network
path (host vs. container) reached Keycloak.

## 9. `TenantMiddleware` is implemented as a Guard, not Express middleware

The mandated flow is `Auth Guard -> Organization Extractor -> Tenant
Resolver -> ...`, strictly in that order. NestJS's pipeline runs **all**
middleware before **any** guard, regardless of registration order or which
routes they're scoped to. If `tenant.middleware.ts` were real
`NestMiddleware`, it would run *before* `AuthGuard` and therefore before the
JWT (and its `org_slug` claim) had been verified -- breaking the mandated
ordering and creating a path where tenant resolution could be attempted
against unverified/absent claims.

`tenant/tenant.middleware.ts` therefore implements `CanActivate` (a Guard)
and is applied via `@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)`,
which Nest executes strictly in array order. The file keeps its spec'd name
and location; only the interface it implements differs, and that difference
is what makes the mandated ordering achievable at all in Nest. `tenant/tenant.resolver.ts`
holds the actual DB lookup logic and is unaffected.

## 10. `PerfController`'s `raw-query` endpoint deliberately uses `migration_user`

`GET /api/v1/perf/raw-query` is the one sanctioned exception to "never use
migration_user in application code" -- it exists solely to measure RLS
overhead for PERF-01 vs PERF-02, exactly as specified. It is hard-gated to
`NODE_ENV=test` (checked at request time, throws 403 otherwise) and reachable
by no other code path. See `app/src/perf/perf.controller.ts`.

## 11. Files added beyond the literal directory tree

`app/src/rbac/rbac.module.ts`, `app/src/rbac/test.controller.ts`,
`app/src/perf/perf.module.ts`, and the top-level `test-support/` and
`test-results/` directories aren't named in the original file tree, but are
required to satisfy explicit requirements in the same spec (the two RBAC
test endpoints, the perf endpoints, and shared test helpers to avoid
duplicating Keycloak/TOTP logic across five test files). No scope beyond
what's explicitly required elsewhere in the spec was added.

## 12. Migrations run via `/postgres/init`, not `drizzle-kit push`/`migrate`

`02_schema.sql` (executed by `migration_user` at container init) is the
schema's source of truth, matching the DDL given verbatim in the spec.
`app/src/database/schema.ts` mirrors it for type-safe Drizzle queries, and
`drizzle.config.ts` exists so `drizzle-kit` can introspect/typecheck the
schema during development, but no `drizzle-kit push`/`migrate` step is run
against the database -- that would attempt to (re)create objects the init
scripts already own. This is a tooling choice, not a security-relevant
decision.
