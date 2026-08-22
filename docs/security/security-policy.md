# Security Policy

## Reporting

This is a pre-production architecture validation / engineering-foundation
repository, not a deployed product -- there is no public-facing instance to
report vulnerabilities against yet. Internally, file findings the same way as
any other issue, tagged `security`, and flag them to the maintainer directly
rather than filing a public issue if the finding is exploitable against a
future deployment.

## Review gates (enforced via CLAUDE.md)

The following changes require documenting the change (with context and
reasoning) in `docs/architecture/decisions.md` **before** implementing, and
human review before merge:

- Any RLS policy change (`packages/database/migrations/003_rls.sql` and its
  mirrors)
- Any auth or JWT validation change (`apps/api/src/auth/`)
- Any tenant isolation logic change (`apps/api/src/tenant/`)
- Any database migration
- Any security-related dependency update
- Any change to `CLAUDE.md` itself

## Dependency security

- `npm audit --audit-level=high` runs in CI on every push/PR
  (`.github/workflows/ci.yml`) and must pass with zero high/critical findings
  before merge.
- A scheduled weekly scan (`.github/workflows/security.yml`) runs
  `npm audit --audit-level=moderate` and, on pull requests, GitHub's
  `dependency-review-action`.
- Dependency version bumps that touch auth, database drivers, or crypto
  libraries fall under the review-gate list above.

## Secrets handling

- No secret is ever hardcoded in source. `.env.example` documents required
  variables with `CHANGE_ME` placeholders only.
- `.env.local` (real local values) is gitignored and never committed.
  `infra/postgres/init/*` and `infra/docker/docker-compose.yml` intentionally
  contain plaintext **local-only, non-production** Docker Compose passwords
  (e.g. `app_dev_pass_local`) -- these are dev-environment bootstrap values,
  not real secrets, and are not sensitive outside a developer's own machine.
- Every CI push is scanned for accidentally-committed secrets via
  TruffleHog (`ci.yml`, `security-audit` job).
- `migration_user` and the Postgres superuser connection
  (`DATABASE_ADMIN_URL`) are never used by application runtime code -- only
  by migration tooling (`infra/postgres/migrate.js`) and the one hard-gated,
  test-only perf diagnostic endpoint (see
  `docs/architecture/decisions.md` ADR-010).

## Tenant isolation

Tenant isolation is enforced at the database layer (PostgreSQL RLS with
`FORCE ROW LEVEL SECURITY`), not just in application code, and is covered by
an automated regression suite (`tests/security/rls.test.ts`,
`tests/security/pooling.test.ts`) that must pass in CI before merge. See
`docs/architecture/threat-model.md` for the full threat/control mapping.
