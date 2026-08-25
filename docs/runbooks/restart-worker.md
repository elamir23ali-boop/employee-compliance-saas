# Runbook: Restart the worker

Scope: `apps/worker` (a single process running 4 BullMQ workers --
`reminders`, `reminder-scans`, `imports`, `failure-alert-scans`; see
`apps/worker/src/main.ts`). No admin UI (Bull Board or similar) exists in
this repo -- checking queue state means a short ad-hoc script against the
same Redis the worker uses, or `bullmq`'s API directly.

## 1. Check if a job is mid-flight

**Primary method -- BullMQ's own active-job state.** The worker only logs
on job *completion* (`reminder_processed`/`reminder_suppressed`/
`import_processed`/`reminder_scan_completed`/`failure_alert_scan_completed`,
etc. -- see `apps/worker/src/workers/*.ts`), never on job *start*, so log
lines alone cannot tell you whether something is currently running. Run
this from the repo root (it uses the `bullmq` dependency already installed
there, no new tooling):

```
REDIS_URL="<same REDIS_URL apps/worker uses>" node -e "
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const queues = ['reminders', 'reminder-scans', 'imports', 'failure-alert-scans'];
(async () => {
  for (const name of queues) {
    const q = new Queue(name, { connection });
    const active = await q.getActive();
    console.log(name, '->', active.map((j) => ({ id: j.id, name: j.name })));
    await q.close();
  }
  await connection.quit();
})();
"
```

An empty array for every queue means nothing is currently mid-flight.

**Secondary signal -- worker logs**, useful only for *recent history*, not
current state: `docker logs <worker container> --tail 100` and look at the
most recent completion line's `jobId` to understand what it was last doing
-- it does not tell you whether another job started after that line and is
still running.

## 2. If a job is mid-flight

Compare against what step 1 shows:

- **`reminders`/`imports` job active**: these process one document/row
  batch at a time and normally finish in well under a second (SMTP send is
  bounded to ~10s, ADR-030). Waiting a few seconds and re-checking is
  almost always fine.
- **`reminder-scans`/`failure-alert-scans` job active**: these loop over
  every active tenant in one job (`reminder-scanner.worker.ts`/
  `failure-alert-scanner.worker.ts`) -- can legitimately take longer on a
  tenant-heavy deployment. If this is the daily 06:00 UTC reminder scan or
  the hourly failure-alert scan and it's still running, prefer waiting for
  it to finish over interrupting it -- SIGTERM (step 3) will let it finish
  before the process exits anyway (E5 Pillar 1), so there is rarely a
  reason to force an interrupt.

If the restart is urgent enough that waiting isn't acceptable, understand
the tradeoff before proceeding to step 3 regardless: graceful shutdown
still finishes the *current* job before exiting (never abandons one
mid-execution -- confirmed against `Worker.close()`'s own source, E5
Pillar 1 commit), so step 3 itself never corrupts an in-flight job; the
only cost of not waiting is that the restart takes as long as the current
job takes to finish, not that anything breaks.

## 3. Send SIGTERM (graceful shutdown)

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production stop worker
```

(`docker compose stop` sends SIGTERM, then SIGKILL after its own grace
period if the process hasn't exited -- Compose's default grace period is
10s; this repo's worker has no explicit `stop_grace_period` set in
`docker-compose.production.yml` today, so a job that takes longer than 10s
to finish draining risks being killed by Compose before its own graceful
logic completes. If jobs in this deployment routinely run long, set
`stop_grace_period` explicitly in the compose file rather than relying on
the 10s default.)

Expect, in `docker logs`: `{"action":"worker_shutdown_started",...}`
followed by `{"action":"worker_shutdown_completed",...}` once the current
job (if any) finishes and every queue/connection closes.

## 4. Wait for process exit

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production ps worker
```

Confirm the container has actually stopped (not just "stopping") before
proceeding. If it hasn't exited within ~60s of `worker_shutdown_started`
appearing in the logs, something is hung -- investigate rather than
force-killing blindly (check what job was active per step 1 immediately
before the SIGTERM).

## 5. Restart worker process

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production start worker
```

## 6. Verify

- `docker logs <worker container>` shows
  `Worker process started (reminders, imports, failure-alert scans)` with
  no error immediately after.
- Re-run step 1's script -- queues should show activity resuming (or stay
  empty if nothing is currently due) rather than erroring.
- `notification_log` continues to gain new rows over the next scan cycle --
  spot-check via `docs/runbooks/investigate-failed-notifications.md`'s
  query 1, or `GET /api/v1/notification-log/stats` for a tenant you have a
  token for.
