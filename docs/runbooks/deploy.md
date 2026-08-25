# Runbook: Deploy

Scope: `apps/api` + `apps/worker`, via `infra/docker/docker-compose.production.yml`
(E5 Pillar 2). Does not cover Keycloak (excluded from that compose file --
see its own top-of-file comment and ADR-032's neighbor context in
`docs/architecture/decisions.md`) or any AWS/orchestration topology (E6).

> **A known gap this runbook does not paper over**: `infra/postgres/migrate.js`
> was built to bootstrap a *fresh* database (CI, or a first-ever production
> deploy) by running every file in `packages/database/migrations/*.sql` in
> order, unconditionally. It has no "already applied" tracking (no
> `schema_migrations`-style table exists in this schema). Re-running it
> against a database that already has migrations 001-010 applied will fail
> on the first already-existing object. **Step 3 below reflects that
> reality** -- a first deploy differs from every deploy after it.

## 1. Pre-deploy checklist

- [ ] CI green on the commit being deployed (all 5 `ci.yml` jobs -- lint,
      unit-tests, integration, security-scan, build)
- [ ] No open incident that this deploy isn't specifically fixing (check
      recent `notification_failure_rate_alert` log lines --
      `docs/runbooks/investigate-failed-notifications.md`)
- [ ] `.env.production` is populated from `.env.production.example` with
      real values for this environment (never committed -- CLAUDE.md)
- [ ] If this deploy includes a new file under
      `packages/database/migrations/`, read the Review Gates note in
      CLAUDE.md ("Any database migration" requires human review before
      implementing) -- confirm that review already happened before
      proceeding

## 2. Pull latest images

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production build
```

(No registry/push exists in this repo yet -- ADR-029 decision #7 -- images
are built locally on the deploy target. If a registry is introduced later,
replace this step with a `pull`.)

## 3. Run migrations

**First-ever deploy to a fresh database** (no prior migrations applied):

```
DATABASE_ADMIN_URL=<superuser connection string> node infra/postgres/migrate.js
```

This applies every file in `packages/database/migrations/` in order, as the
Postgres superuser -- the SQL files themselves `SET ROLE migration_user`
for the statements that create/own objects (ADR-002); `migrate.js` never
uses `app_user` or `migration_user` as its own connecting credential
(CLAUDE.md: "NEVER use migration_user in application runtime code" --
this is tooling, and it deliberately doesn't use it either, since
`migration_user` lacks `CREATEROLE` and `001_roles.sql` is what creates
both roles in the first place).

**Every subsequent deploy that adds a new migration file** (the common
case): `migrate.js` cannot be re-run as-is (see the gap noted above). Apply
only the new file(s) by hand, in order, as the superuser:

```
psql "<DATABASE_ADMIN_URL>" -f packages/database/migrations/0NN_the_new_one.sql
```

**Verify the migration applied** -- there is no tracking table to query;
verify by inspecting the resulting schema directly for whatever that
migration actually added, e.g.:

```sql
-- new table
SELECT to_regclass('public.the_new_table');
-- new column
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'the_table' AND column_name = 'the_new_column';
-- new index (this repo's own pattern, e.g. ADR-031's
-- idx_notification_log_status_sent_at)
SELECT indexname FROM pg_indexes WHERE tablename = 'the_table';
```

A deploy with no new migration file skips this step entirely.

## 4. Restart API

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production up -d --no-deps api
```

Compose sends SIGTERM to the old container, which (E5 Pillar 1) stops
accepting new connections, drains in-flight requests (capped at 30s), logs
`api_shutdown_started`/`api_shutdown_completed`, then exits -- before the
new container starts serving.

Confirm:

```
curl -f http://<api-host>:3000/health/ready
```

Wait for `200 {"status":"ready",...}` -- the compose healthcheck already
polls this every 10s, but confirm it directly rather than trusting
`docker ps`'s "healthy" alone.

## 5. Restart worker

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production up -d --no-deps worker
```

Same SIGTERM handling (E5 Pillar 1): stops picking up new jobs, finishes
any job already in progress (`Worker.close()` with no `force` argument --
confirmed against bullmq's own source, never abandons a job mid-execution),
logs `worker_shutdown_started`/`worker_shutdown_completed`, exits.

Confirm via `docker logs <worker container>` -- expect
`Worker process started (reminders, imports, failure-alert scans)` with no
immediately-following error.

## 6. Post-deploy smoke test

```
curl -f http://<api-host>:3000/health
curl -f http://<api-host>:3000/health/ready
```

Plus one real authenticated API call against a known-safe read endpoint,
e.g. `GET /api/v1/notification-log/stats` with a valid tenant-admin token
-- confirms the DB connection, RLS, and auth path all actually work, not
just that the process is listening.

## 7. Rollback trigger

If `/health/ready` still returns 503 two minutes after step 4/5 complete,
stop and roll back rather than continue troubleshooting live:

1. Revert to the previous image tag/build (`docker compose ... up -d
   --no-deps api worker` against the prior commit's built images).
2. If a migration was applied in step 3, see
   `docs/runbooks/rollback-migration.md` before assuming the app rollback
   alone is sufficient -- a schema change may not be backward-compatible
   with the previous code version.
