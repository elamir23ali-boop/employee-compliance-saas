# Data Classification

Classifies the data types this system's locked architecture (`tenants`,
`employees`, `documents`, `idempotency_keys`, and -- as of E2 --
`audit_events`, `expiry_policies`; see `packages/database/src/schema.ts`)
actually handles today. Extend this table when a future phase introduces new
data, not before.

| Data                                                      | Classification               | Examples                            | Handling rule                                                                                                                                  |
| --------------------------------------------------------- | ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Employee identity (`full_name`, `first_name`, `last_name`, `employee_code`) | Restricted (PII)             | `full_name`, `employee_code`        | Never logged (CLAUDE.md); RLS-scoped per tenant; synthetic-only in all non-prod data (`004_seed_dev.sql`)                                      |
| Employee contact/org fields (`email`, `job_title`, `branch`, `responsible_officer_id`) | Restricted (PII) | work email, job title, branch name | Never logged; RLS-scoped; synthetic-only in test/seed data (E2)                                                                                 |
| Document data (`doc_number`, `expiry_date`, `doc_type`, `exception_reason`) | Restricted (PII / sensitive) | passport/residence/badge numbers    | Never logged; RLS-scoped; real document numbers are prohibited in this codebase at every phase (CLAUDE.md)                                     |
| Audit before/after state (`audit_events.before_state`/`after_state`)      | Restricted (PII)             | employee names/doc numbers as they existed at the time of a write | Intentionally retains PII (an audit trail must show what changed); never logged to app logs (only PII-free prefixes, see ADR-020); RLS-scoped; app_user has SELECT+INSERT only, no UPDATE/DELETE; not exposed via any HTTP endpoint in E2 |
| Expiry policy thresholds (`expiry_policies.*_days`, `auto_block`)         | Internal                     | `warning_days_1: 90`                | Tenant-configurable numbers, no PII; RLS-scoped like any tenant-owned config                                                                    |
| Tenant metadata (`name`, `slug`, `status`)                | Internal                     | `org-tenant-a`                      | Not RLS-scoped by design (must be resolvable before tenant context exists) -- deliberately low-sensitivity: slug and display name only, no PII |
| Auth tokens (JWT access tokens)                           | Secret (short-lived)         | Bearer tokens                       | Never logged; transmitted only via `Authorization` header over the local dev network; production transport security is a later-phase concern   |
| Idempotency keys                                          | Internal                     | opaque string keys                  | RLS-scoped; contain no PII themselves but are tenant-attributed                                                                                |
| Credentials (`DATABASE_URL`, `KEYCLOAK_ADMIN_PASS`, etc.) | Secret                       | connection strings, admin passwords | Never committed (`.gitignore`); `.env.example` documents shape only, with `CHANGE_ME` placeholders                                             |

## Rules that apply across all classifications

- **Restricted/Secret data is never logged.** Worker logs, for example, only
  ever include `tenantId.substring(0, 8)` -- never a full UUID, and never any
  employee/document field.
- **No real employee data or real document numbers, at any phase** -- not
  just E0/E1. All seed and test data is synthetic (`EMP-A1`, `DOC-A-001`,
  etc.).
- **Restricted data is tenant-isolated via RLS**, not application-layer
  filtering. Tenant metadata is the sole intentional exception, and it is
  low-sensitivity by design.
