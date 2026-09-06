# E6 Phase 5 — Failure & Resilience + Backup/Restore

Status: COMPLETE

Injects real infrastructure failures against the running stack (300K seed) and
records exactly what the API and worker do, then runs a full `pg_dump` /
`pg_restore` drill. **Validation only** — no features, no migrations, no ADR.
Two real robustness defects surfaced (both in the same place: the `pg` pool
has no connection-error handler); both are flagged for E7, neither is fixed
here. A new operational runbook (`docs/runbooks/backup-restore.md`) was
written and every command in it verified.

## Environment

300K seed (Phase 4 state), `apps/api` + `apps/worker` from `dist/` on the
Windows host, Docker stack (`docker-*` compose project). Failures injected
with `docker stop`/`start`/`restart` and `pg_terminate_backend`. The host
cannot send a real POSIX `SIGTERM` to the host node processes, so graceful
shutdown itself is not re-tested here — E5 Pillar 1 verified that against the
production Docker images with `docker stop`. What Phase 5 adds: **the crash
paths below bypass graceful shutdown entirely.**

## Resilience matrix

| # | Injection | API process | Worker process | `/health/ready` | Recovery |
|---|---|---|---|---|---|
| **R1** | Postgres `docker restart` | **CRASHES** | **CRASHES** | — (process dead) | none in dev; in prod `restart: unless-stopped` respawns it (~seconds, in-flight requests lost, drain skipped) |
| **R2** | Redis `docker stop` → `start` | survives | survives | correctly `503 {"redis":"fail"}` → `ready` ~10 s after Redis returns | **automatic** |
| **R3** | Keycloak `docker stop` → `start` | survives; already-issued tokens still `200` | unaffected | stays `200` | new logins resume when Keycloak returns |
| **R4** | MailHog `docker stop` + reminder scan | survives | survives; 2,959 `notification_log` rows → `FAILED` | `200` | **self-heals** — next scan re-enqueues, delivers, rows → `SENT` |
| **R5** | Worker killed with ~5k jobs queued, then restarted | — | BullMQ reclaims stalled + waiting jobs, processes all 16k against healthy MailHog | — | **automatic** on restart; no jobs lost |
| **R6** | `pg_terminate_backend()` on **one idle** pooled connection | **CRASHES** | (same code path) | — (process dead) | same as R1 |

### R1 / R6 — a Postgres connection reset crashes the process ⚠️ headline finding

```
node:events:487
      throw er; // Unhandled 'error' event
      ^
error: terminating connection due to administrator command      // SQLSTATE 57P01
Emitted 'error' event on BoundPool instance at:
    at Client.idleListener (node_modules/pg-pool/index.js:62:10)
    ...
  code: '57P01',
Node.js v24.15.0                                                 // <- process exits
```

`packages/database/src/index.ts` `createDb()` does `new Pool(config)` and
**never attaches `pool.on('error', …)`**. Both `apps/api` (`DrizzleService`)
and `apps/worker` (`main.ts`) build their pool through it. When Postgres sends
`57P01` to an **idle** pooled client — which happens on a Postgres restart, a
failover, a `pg_terminate_backend` (routine: connection poolers, DBAs, RDS
maintenance all do this), or a server-side idle timeout — `pg-pool` re-emits
it as an `'error'` event on the pool. With no listener, Node's default is
`throw`, and the process exits.

- R1 (`docker restart docker-postgres-1`): **both** API and worker died within
  the ~4 s Postgres was unavailable, and stayed dead — Postgres itself was
  back in 4 s.
- R6 (`pg_terminate_backend` on a single idle `app_user` connection, Postgres
  otherwise fully up): API died just the same. This is the more alarming case —
  a routine single-connection kill takes down the whole API.

Contrast R2: `ioredis` ships automatic reconnection **and** `HealthService`
explicitly does `this.redis.on('error', () => undefined)` — so Redis loss
degrades gracefully. The DB path has neither guard.

**Fix (out of E6 scope):** `pool.on('error', (err) => { /* structured,
PII-free log */ })` in `createDb()` — this is exactly what the `pg` docs
prescribe. One-line change to a review-gated file (DB layer). **Flag for E7**
(or a standalone hardening PR — it is small and high-value). Until then, the
prod container `restart:` policy is the only thing keeping a DB blip from
being an outage, and it converts every blip into a hard restart with
in-flight request loss and no drain.

### R2 — Redis loss (good)

`/health/ready` flips to `503 {"status":"not_ready","checks":{"db":"ok","redis":"fail"}}`
within one check, recovers to `ready` ~10 s after Redis is back. Neither
process crashes. The worker logs raw `ECONNABORTED` / `ECONNRESET` lines while
disconnected (unstructured, noisy — minor: a `connection.on('error')` handler
on the worker's `IORedis` would quiet these) but BullMQ reconnects and resumes
on its own.

### R3 — Keycloak loss (good)

`/health/ready` has no Keycloak check by design (Keycloak is not required to
serve requests that carry an already-valid JWT — the API validates against
**cached** JWKS). Authenticated calls with a live token keep returning `200`
throughout the outage; only new logins fail (nothing the API can do). No
crash. Note: a Keycloak outage longer than the JWKS cache TTL **and**
coinciding with a signing-key rotation would start failing token validation —
not observed here, but worth a monitor in production.

### R4 — SMTP loss + self-heal (good, as ADR-026 designed)

`docker stop docker-mailhog-1`, then a reminder scan: 2,959 Alpha documents
recorded `status='FAILED'` in `notification_log` with structured PII-free
`reminder_dispatch_failed` log lines. Each failed send took the full 10 s SMTP
timeout (`connectionTimeout`/`greetingTimeout`/`socketTimeout`, ADR-030) —
bounded, but a large batch under a real SMTP outage will be slow. After
`docker start docker-mailhog-1` + a re-scan, those documents were
re-enqueued (the dedup check is `status='SENT'` only, so `FAILED` rows do not
block a retry) and delivered — **6,806 SENT** for Alpha, **9,183 messages** in
MailHog. The `FAILED` rows persist as history; this is the ADR-026 design, and
it works at scale.

### R5 — worker crash + BullMQ durability (good)

After the worker process exited (see note), restarting it caused BullMQ to
reclaim the stalled `active` jobs and drain the ~16k-job `reminders` backlog
that had accumulated in Redis — every job eventually `SENT`, none lost. Job
durability across a worker crash holds.

*(Note: the worker also exited once during a compound Redis-restart +
SMTP-restart sequence. Root cause not isolated — the test harness had called
`queue.obliterate()`, which is known to disrupt a live BullMQ `Worker`, so
this is not cleanly attributable to the infra failure. The R1 pg-pool crash,
by contrast, is fully reproducible and affects both processes.)*

## Backup / Restore drill

Full `pg_dump -Fc` → `pg_restore` into a scratch database, on the 300K seed.
Every command is now in **`docs/runbooks/backup-restore.md`** (new this
phase), verified end-to-end.

| step | result |
|---|---|
| `pg_dump -Fc e0db` | **13.5 s**, **45.5 MB** file, taken against the live stack (API + worker running) — consistent snapshot, no maintenance window |
| `pg_dumpall --roles-only` | captures `app_user` / `migration_user` (roles are cluster-global, **not** in the `-Fc` DB dump — a gotcha the runbook calls out) |
| `pg_restore -d e0db_restore` | **39 s**, exit 0, zero errors |
| row counts (employees / documents / tenants / audit_events) | **identical** to source: 300,015 / 735,506 / 8 / 1,203 |
| RLS armed | `relrowsecurity` + `relforcerowsecurity` = `t` on all 6 tenant-owned tables; `tenants` = `f`/`f` (correct) |
| policies | all 8 `tenant_isolation_*` present |
| `audit_events` grants for `app_user` | `SELECT`, `INSERT` only — **append-only survived the dump** |
| RLS **enforces** (not just present) | as `app_user`: Alpha ctx → 150,000 employees, Beta ctx → 75,000, **empty ctx → 0** (NULLIF guard intact) |
| `audit_events` append-only **enforces** | `UPDATE` → `permission denied`, `DELETE` → `permission denied` |

Every security property this project depends on — RLS, `FORCE RLS`, the
`NULLIF` tenant guard, `tenant_isolation_*` policies, and the append-only
`audit_events` grant — is preserved by `pg_dump`/`pg_restore` and enforces in
the restored copy exactly as in the live database.

Gaps documented in the runbook, not resolved here (all E-future / AWS work):
no automated backups, no WAL archiving, no PITR; `pg_restore` carries no
planner statistics (`ANALYZE` required after — Phase 3/4 showed how plan-
sensitive the O(n) paths are); Redis and Keycloak state are out of scope of a
DB dump.

## Test suite after the chaos

With the 300K seed still loaded and the stack restarted after the crash
tests: `unit 90/90 · security 52/52 · integration 36/36` = **178/178**
(security 99 s, integration 188 s). The failure injection left no persistent
damage — the reminder churn added ~10k seed-tenant `notification_log` rows
but the E0-fixture assertions the security suite depends on are untouched.

## Watch-items → E7

1. **`createDb()` needs `pool.on('error', …)`** (R1/R6) — a Postgres restart
   or a single idle-connection kill crashes both the API and the worker. The
   single highest-value resilience fix; one line in a review-gated file.
2. Worker `IORedis` could use a `.on('error')` to stop spraying raw
   `ECONNABORTED`/`ECONNRESET` at the log during a Redis blip (cosmetic;
   BullMQ already recovers).
3. Keycloak outage + JWKS-cache expiry + key rotation is an untested corner —
   add a production monitor on JWKS fetch failures.
4. SMTP outage makes each reminder send take the full 10 s timeout — a large
   batch during a provider outage is slow (bounded, not broken). A circuit
   breaker / "SMTP is down, stop trying for N minutes" would help; ADR-026's
   next-scan retry already prevents data loss.
5. No automated backups / PITR anywhere in this repo — the manual runbook is
   the whole story until the AWS/RDS epoch.

None of these blocks the E6 gate: the system is **correct** through every
failure (no data loss, no isolation leak, backup/restore preserves every
security property) and **self-heals** from Redis, Keycloak, SMTP, and
worker-crash failures. It does **not** currently self-heal from a Postgres
connection reset — it crashes and relies on the container restart policy.

## Cleanup

Scratch DB `e0db_restore` and the `/tmp` dump files were dropped. 300K seed
left in place. `notification_log` carries ~10k extra seed-tenant rows from the
R4/R5 reminder churn (harmless; `npm run cleanup` removes them). API + worker
restarted and healthy after the crash tests.
