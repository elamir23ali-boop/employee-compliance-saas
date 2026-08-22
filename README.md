# Employee Compliance SaaS

Security-first, multi-tenant SaaS for employee document compliance.
Multi-tenancy is enforced with a shared PostgreSQL database and Row-Level
Security (RLS) -- not application-layer filtering.

**Status:** E1 -- Engineering Foundation. E0 (Architecture Validation POC)
is complete: **19/19 security tests PASS**. See `docs/e0/` for the full E0
validation record. E1 is the monorepo structure, CI pipeline, and security
baseline this record now lives inside -- not a feature milestone. See
`docs/architecture/decisions.md` for the full decision log (E0 + E1).

## Architecture overview

- **Database:** PostgreSQL 18, `app_user` (non-superuser, `FORCE RLS`,
  cannot bypass RLS) for all application code + `migration_user`
  (`BYPASSRLS`) for migrations only, never used at runtime.
- **Tenant isolation:** RLS policies on `employees`, `documents`, and
  `idempotency_keys`, keyed on a per-transaction `SET LOCAL
app.current_tenant_id`. Tenant ID is always derived server-side from a
  verified JWT's `org_slug` claim → DB lookup -- never trusted from the
  client.
- **Auth:** Keycloak 26.7.2, OIDC direct-grant + TOTP.
- **RBAC:** Server-side role hierarchy (`viewer < hr-staff < hr-manager <
tenant-admin < platform-admin`), defined once in `packages/shared`.
- **Workers:** BullMQ (`apps/worker`), tenant-scoped per job payload, with
  idempotency-key deduplication.
- **ORM:** Drizzle ORM (`packages/database`) for type-safe queries; schema
  migrations are plain SQL (`packages/database/migrations`), not
  `drizzle-kit push`/`migrate`.

See `docs/architecture/threat-model.md` and
`docs/architecture/data-classification.md` for more detail.

## Repository layout

```
apps/api        NestJS API
apps/worker     Standalone BullMQ worker process
packages/database  Shared Drizzle schema, SQL migrations, DB connection helper
packages/shared    Shared types, constants (roles, etc.)
infra/docker       docker-compose for local dev
infra/postgres      Migration bootstrap script
tests/security      RLS, pooling, RBAC tests
tests/integration   Keycloak auth, worker tests
tests/load          k6 load test
docs/               Architecture, security, and E0 validation docs
```

## Prerequisites

- Docker Desktop (with Docker Compose v2)
- Node.js 24 LTS (see `.nvmrc`)
- `k6` (optional -- the load test can also run via
  `docker run grafana/k6 run /scripts/baseline.js`, no local install needed)

## Setup

```powershell
# 1. Copy environment defaults and fill in local values
cp .env.example .env.local

# 2. Start infrastructure (Postgres, Redis, Keycloak)
npm run docker:up

# 3. Install dependencies
npm install

# 4. Build shared packages
npm run build
```

`docker-entrypoint-initdb.d` (via `infra/postgres/init`) applies roles,
schema, RLS, and seed data automatically on first container start. To apply
migrations against an already-initialized or CI database instead, run
`npm run db:migrate` (uses `DATABASE_ADMIN_URL`, the Postgres superuser --
never used by application code).

## Running the app

```powershell
npm run dev --workspace=@ecs/api      # API on :3000
npm run dev --workspace=@ecs/worker   # worker process
```

## Running the tests

The API must be running and all Docker services healthy first.

```powershell
npm run test:security      # RLS, pooling, RBAC
npm run test:integration   # Keycloak auth, worker
npm run typecheck
npm run lint
```

## Running the load test

```powershell
docker run --rm `
  -v "${PWD}\tests\load:/scripts" `
  -v "${PWD}\test-results:/test-results" `
  -e API_BASE=http://host.docker.internal:3000 `
  -e KEYCLOAK_ISSUER=http://host.docker.internal:8080/realms/e0-test `
  -e SCENARIO=raw `
  grafana/k6 run /scripts/baseline.js
```

## Security model summary

- RLS is enforced at the database layer (`FORCE ROW LEVEL SECURITY`), not
  just in application code.
- Tenant ID is never accepted from a client request.
- `migration_user` is never constructed in application runtime code (one
  hard-gated, `NODE_ENV=test`-only diagnostic endpoint is the sole documented
  exception -- see `docs/architecture/decisions.md` ADR-010).
- See `docs/security/security-policy.md` for the full policy, review gates,
  and dependency/secrets handling rules.

## Further reading

- `docs/architecture/decisions.md` -- full decision log
- `docs/architecture/threat-model.md`
- `docs/architecture/data-classification.md`
- `docs/e0/` -- original E0 validation results
- `CLAUDE.md` -- security rules for AI-assisted development in this repo
