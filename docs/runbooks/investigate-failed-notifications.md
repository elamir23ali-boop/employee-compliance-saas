# Runbook: Investigate failed notifications

Scope: `notification_log` rows with `status = 'FAILED'` or `'SUPPRESSED'`
(see `apps/worker/src/workers/reminder.worker.ts` and ADR-026/ADR-030 for
the SENT/FAILED/SUPPRESSED/idempotency design this runbook assumes).

All SQL below is PII-free by construction -- `notification_log` never
stores employee name, document number, or email address (only
`document_id`, `error_message`, and counts; see
`docs/architecture/data-classification.md`).

## 1. Query notification_log for FAILED rows

```sql
SELECT tenant_id, document_id, days_before_expiry, error_message, sent_at
FROM notification_log
WHERE status = 'FAILED'
ORDER BY sent_at DESC
LIMIT 50;
```

Run this as `app_user` inside a transaction with tenant context set
(`SELECT set_config('app.current_tenant_id', '<tenant-uuid>', true)`) to
scope to one tenant, matching this repo's RLS pattern everywhere else
(ADR-003) -- or as `migration_user`/the superuser (bypasses RLS,
ADR-010-style, for a cross-tenant incident sweep) if you're investigating
a suspected platform-wide SMTP outage rather than one tenant's issue.

## 2. Check structured alert logs

```
docker logs <worker container> 2>&1 | grep notification_failure_rate_alert
```

Emitted hourly (`failure-alert-scanner.worker.ts`, ADR-031) whenever a
tenant's trailing-6h failure rate crosses 50% over at least 5 attempts
(`FAILURE_RATE_ALERT_THRESHOLD`/`MIN_ATTEMPTS_FOR_ALERT`,
`apps/worker/src/workers/failure-alert-policy.ts`). Fields: `tenantId`
(8-char prefix only), `windowHours`, `failedCount`, `totalAttempts`,
`failureRate`. No dedup (ADR-031 decision #6) -- an ongoing outage re-emits
this line every hour until the rate drops, so the *number* of these lines
isn't itself a severity signal, only their continued presence.

## 3. Check the stats endpoint

```
GET /api/v1/notification-log/stats?windowHours=24
Authorization: Bearer <tenant-admin token>
```

(**Not** `GET /api/v1/notifications/health` -- that endpoint does not
exist in this codebase. The real one is
`/api/v1/notification-log/stats`, tenant-admin only, strictly scoped to
the caller's own tenant -- ADR-031. `windowHours` defaults to 24, range
1-720.) Returns `sentCount`/`failedCount`/`suppressedCount`/
`totalAttempts`/`failureRate` (`null` failureRate means zero attempts in
the window, not zero failures -- ADR-031 decision #4: the denominator
excludes `SUPPRESSED`).

## 4. Common causes

**a. SMTP misconfigured.** `error_message` on the FAILED row is the raw
transporter error (truncated to 500 chars, ADR-030) -- e.g. an auth
failure, a connection timeout (bounded to ~10s per `SMTP_*_TIMEOUT`,
ADR-030 decision #4), a TLS mismatch. Check `SMTP_HOST`/`SMTP_PORT`/
`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS` in the worker's actual running
environment (`.env.production.example`'s SMTP section) against what the
provider currently expects -- a rotated credential or a provider-side
port change are the most common real causes.

**b. Employee email not set.** Row is `SUPPRESSED`, not `FAILED`, with
`error_message = 'no_email_on_file'`. This is expected behavior, not a
bug (ADR-026 decision #2) -- the idempotency key *is* claimed for this
outcome, so it will not retry on its own. Fix the employee's email via
the normal `PATCH /api/v1/employees/:id` path; the next scan cycle that
crosses this document's threshold again will pick it up as a new attempt
(a new `days_before_expiry` value, since the old one is now permanently
claimed).

**c. Document deleted between scan and dispatch.** Row is `SUPPRESSED`
with `error_message = 'document_not_found'`, `document_id = NULL` (the
column is nullable exactly for this case, ADR-028 fix). This is the race
ADR-026's SUPPRESSED path was designed for and ADR-028 fixed a real FK-
violation bug in -- if you see a `FAILED` row (not `SUPPRESSED`) whose
`error_message` looks like a Postgres foreign-key error rather than an
SMTP error, that is the ADR-028 bug regressing; escalate immediately
rather than treating it as routine SMTP flakiness.

## 5. Manual re-scan trigger

**No HTTP endpoint exists for this** -- there is no
`POST /api/v1/tenants/:tenantId/reminders/trigger-scan` (or any similar
route) anywhere in this codebase; do not assume one and don't build one
under this runbook (CLAUDE.md: "NEVER add features outside current phase
scope"). The real, available mechanism is enqueueing a one-off job onto
the `reminder-scans` queue directly, the same way
`docs/runbooks/restart-worker.md`'s step 1 script talks to BullMQ:

```
REDIS_URL="<same REDIS_URL apps/worker uses>" node -e "
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const q = new Queue('reminder-scans', { connection });
q.add('scan-expiring-documents', {}, { jobId: 'manual-' + Date.now() })
  .then((job) => console.log('enqueued', job.id))
  .finally(() => q.close().then(() => connection.quit()));
"
```

This triggers the same code path as the daily 06:00 UTC cron
(`reminder-scanner.worker.ts`) immediately, for every active tenant --
there is no per-tenant-only trigger today. Note this re-scans *all*
outstanding thresholds across every tenant, not just the one you're
investigating; on a large deployment prefer waiting for the next
scheduled cycle unless the situation is urgent enough to justify the
extra load.

## 6. Escalation

If the `FAILED` count for the same tenant (or the same `days_before_expiry`
threshold on the same underlying issue) keeps growing across 3+ consecutive
scan cycles -- i.e. the daily scan's own self-healing retry (ADR-026: a
`FAILED` row claims no idempotency key, so the next scan retries it) isn't
resolving it -- treat it as a real outage, not transient flakiness:
escalate to whoever owns the SMTP provider relationship, and check
`docs/runbooks/investigate-failed-notifications.md` step 4a's checklist
against the provider's current status page before assuming this repo's
own code regressed.
