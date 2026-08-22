# CLAUDE.md — Employee Compliance SaaS

## Project

Security-first multi-tenant SaaS — employee document compliance for UAE companies.
Multi-tenant: Shared PostgreSQL + Row-Level Security (RLS).

## Current Phase: E1 — Engineering Foundation

E0 complete: 19/19 security tests PASS.
E1 established the repository structure, CI, and monorepo layout only. No MVP features yet.

## ABSOLUTE PROHIBITIONS

- NEVER use --dangerously-skip-permissions
- NEVER hardcode secrets in source files
- NEVER use migration_user in application runtime code
- NEVER bypass RLS in application code
- NEVER trust tenant_id from client — always derive from JWT → DB lookup
- NEVER store tenant context in global or module-level variables
- NEVER log PII (names, document numbers, emails, full UUIDs)
- NEVER use real employee data or real document numbers
- NEVER pass user input to sql.identifier() or dynamic SQL APIs
- NEVER add features outside current phase scope
- NEVER silently change architecture decisions

## Locked Architecture (from E0)

- PostgreSQL 18 + RLS + NULLIF guard + FORCE RLS
- app_user: non-superuser, FORCE RLS
- migration_user: BYPASSRLS, migrations only
- Keycloak 26.7.2, KC_HOSTNAME pinned
- TenantMiddleware runs as NestJS Guard (after AuthGuard)
- SET LOCAL per transaction only
- Drizzle ORM for queries, SQL files for migrations
- BullMQ workers: tenant_id from job payload only

## Review Gates (require human review before implementing)

- Any RLS policy change
- Any auth or JWT validation change
- Any tenant isolation logic change
- Any database migration
- Any security-related dependency update
- Any change to this CLAUDE.md

## Git Rules

- Never force push to main
- Never commit .env.local or any real secrets
- Every security-sensitive change needs a clear commit message explaining why
