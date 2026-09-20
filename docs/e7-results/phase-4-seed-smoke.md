# E7 Phase 4 — Seed Data, Smoke Test, Gate

Closes out E7. Prerequisite: Phase 3 (Sub-phases A/B/C — app stack + Nginx/TLS)
already PASS, `https://compliance.ai-english-os.online` live. This phase
populates that deployment with synthetic data and proves a real, end-to-end
authenticated request actually works — the first time anything in E7 did.

## Seed data

`infra/aws/seed-smoke-data.sh` (new, this phase) reuses the E6 seed tooling
unchanged (`tools/seed/{config,db,generate,keycloak-users}.ts`) at a
staging-appropriate scale instead of E6's 100K load-test volume — same
`app_user`/RLS-respecting write path (`SET LOCAL app.current_tenant_id`
before every insert, never `migration_user`), same synthetic-only
`@test.invalid` data. Runs on the EC2 host via SSM: the host has no repo
checkout, so the 4 seed-tool files are curl+sha256-verified from GitHub (same
pattern as `deploy-stack.sh`) and executed inside a throwaway `node:22-slim`
container (host has no Node runtime installed).

Result (`--count=300`):

| Tenant | Employees |
| --- | --- |
| Alpha Corp | 150 |
| Beta LLC | 75 |
| Gamma Inc | 45 |
| Delta Co | 21 |
| Epsilon Ltd | 9 |
| **Total** | **300 employees + 704 documents = 1,004 rows** |

5 Keycloak `hr-manager` seed users provisioned (`seed-e6-<slug>@e6.local` /
`SeedPass123!`, `org_slug` claim set), matching ADR-035's mechanism.

## Three real bugs found and fixed

None of these were visible from Sub-phase B/C's own verification checks —
all three needed a genuine authenticated request through the real public
domain, which is exactly what this phase's smoke test is for.

1. **`KEYCLOAK_ISSUER`/`KEYCLOAK_JWKS_URI` double-scheme bug** (`8d8f09e`).
   `compliance/prod/keycloak`'s `KC_HOSTNAME` secret field is a full URL
   (`https://compliance.ai-english-os.online/auth`) — Keycloak's own v2
   hostname provider uses it correctly (confirmed via a real token's `iss`
   claim). `deploy-stack.sh` wrongly assumed a bare hostname and built
   `https://${KC_HOSTNAME}/...`, producing an unparseable
   `https://https://.../auth/...`. The API's JWKS fetch failed outright and
   every JWT validation 401'd. Fixed by reusing `KC_HOSTNAME` verbatim (it
   already carries the scheme); `SMTP_FROM_DEFAULT` had the identical bug
   and was fixed the same way with a separately-derived bare host.

2. **nginx doesn't route `/auth/realms/*`** (`fda3e29`). Fix #1's corrected
   `KEYCLOAK_JWKS_URI` (now `https://.../auth/realms/.../certs`) 502'd —
   `nginx.conf`'s path routing only matches bare `/realms|/resources|/...`,
   never `/auth/realms`, so the request fell through to the API catch-all
   instead of reaching Keycloak. Fixed by pointing `KEYCLOAK_JWKS_URI` at
   Keycloak's internal compose-network address
   (`http://keycloak:8080/realms/e0-test/protocol/openid-connect/certs`)
   instead — valid because `jwt.strategy.ts` fetches this URL directly and
   only ever string-compares `KEYCLOAK_ISSUER` against the token's `iss`
   claim; the two were never required to match hosts.

3. **nginx caches the API's IP forever** (`96c11ae`). After fix #1's
   redeploy recreated the `api` container (new internal IP), every real
   request through the public domain 502'd even though the API was healthy
   on `localhost:3000` directly on the host. `proxy_pass http://api:3000;`
   resolves once at nginx startup and never again — standard nginx
   behavior, wrong for a Compose upstream that gets recreated on every app
   redeploy. Fixed with the standard pattern: `resolver 127.0.0.11
   valid=10s` (Docker's embedded DNS) + a `set $upstream ...; proxy_pass
   $upstream;` variable for both `api` and `keycloak`, so nginx re-resolves
   per connection. Future app redeploys no longer need a manual nginx
   restart.

Two smaller fixes landed in the same session: a `deploy-stack.sh`
verification race (worker-log grep ran once, immediately after `up -d`,
before a freshly-restarted worker had printed its startup line — `5f8c9d0`)
and a CRLF-vs-LF-blob checksum-pinning mistake in the new seed script,
caused by this dev machine's `core.autocrlf=true` (`c70ca24`). A 4th
verification check was added to `deploy-stack.sh` (fetch the API's own
rendered `KEYCLOAK_JWKS_URI` from inside the container) so bug #1/#2's class
of failure can never pass Sub-phase B silently again without needing seed
data for a full authenticated-request check.

## Smoke test result: PASS

`k6 run tools/load-tests/scenarios/smoke.js` (E6 tooling, unchanged) against
the real production URL:

```
BASE_URL=https://compliance.ai-english-os.online
KEYCLOAK_ISSUER=https://compliance.ai-english-os.online/realms/e0-test
```

```
checks_total.......: 60      checks_succeeded: 100.00%  checks_failed: 0.00%
http_req_failed....: 0.00%   (0 out of 40)
http_req_duration..: avg=207ms  p(90)=276ms  p(95)=379ms
```

All 6 read paths (health, employee list, employee search, dashboard summary,
dashboard document-stats, dashboard expiring) return 200 with real seeded
data through the full path: public HTTPS → nginx (TLS termination,
dynamic-resolved proxy) → API → JWT validation against Keycloak's real JWKS
→ RLS-scoped Postgres query.

## Not covered by this phase

- No load/stress volume (that's E6's already-completed job, at 100K-500K on
  local Docker) — 300 rows is enough to exercise every endpoint and status
  bucket, nothing more.
- SMTP/reminder-email delivery was not smoke-tested live in this
  environment (real `SmtpEmailDispatcher` since E4 Pillar 3, but no MailHog
  equivalent inspection was done against the real `compliance/prod/smtp`
  provider here).
- `apps/api/src/common/audit-context.ts`'s `actorIp`/`trust proxy` gap
  (flagged during Sub-phase C, E7 memory) is unchanged — still needs an
  image rebuild, deliberately not bundled into this phase's pure-config
  fixes.
