# Runbook: Database backup & restore

Scope: the single PostgreSQL database (`e0db`) that holds every tenant's data.
This repo has **no managed backup service** (no RDS automated snapshots, no
WAL archiving, no PITR) — that is E-future AWS-infrastructure work. What
follows is the manual `pg_dump` / `pg_restore` procedure, verified end-to-end
against the live stack in E6 Phase 5 (see `docs/e6-results/phase-5-*.md`).

Every command below was run for real. Timings are from a 300K-employee /
735K-document seed (~290 MB live data) on the dev stack — a production
database will be proportionally larger and slower.

## What a dump does and does not contain

`pg_dump -Fc e0db` captures: every table's data, all indexes, **all RLS
policies**, `FORCE ROW LEVEL SECURITY` flags, the `NULLIF(...)` tenant guard,
CHECK constraints, and the table-level `GRANT`/`REVOKE` that make
`audit_events` append-only for `app_user`. Verified in Phase 5: a restored
copy enforces tenant isolation and rejects `UPDATE`/`DELETE` on
`audit_events` exactly as the live DB does.

It does **not** contain: the `app_user` / `migration_user` / `postgres`
**roles** themselves (they are cluster-global). Capture those separately with
`pg_dumpall --roles-only` — the restore target must already have them, or the
`GRANT`s in the dump fail.

It also does not contain Redis (BullMQ queue state) or Keycloak (realm/users).
Those are separate concerns — a reminder backlog lost with Redis is
self-healing (the next scan re-enqueues; see
`docs/runbooks/investigate-failed-notifications.md`), and the Keycloak realm
is redeployed from `infra/docker/keycloak/realm-export.json`.

## 1. Take the backup

```
# roles (cluster-global, rarely change — capture once per credential rotation)
docker exec <pg-container> pg_dumpall -U postgres --roles-only -f /tmp/roles.sql

# the database, custom format (compressed, allows selective + parallel restore)
docker exec <pg-container> pg_dump -U postgres -d e0db -Fc -f /tmp/e0db.dump

# copy both off the container / host to durable storage
docker cp <pg-container>:/tmp/e0db.dump  ./backups/e0db-$(date +%Y%m%d-%H%M%S).dump
docker cp <pg-container>:/tmp/roles.sql  ./backups/roles-$(date +%Y%m%d).sql
```

Phase 5 reference: `pg_dump` of the 300K seed took **13.5 s**, produced a
**45.5 MB** file. `pg_dump` runs in a single transaction snapshot — it is
consistent even while the API and worker are live; it does **not** need a
maintenance window, but it does hold a transaction open, so avoid running it
during a long migration.

## 2. Verify the backup is usable (do this every time — a dump you have
never restored is not a backup)

Restore into a throwaway database on the same server and check it:

```
docker exec <pg-container> psql -U postgres -c "CREATE DATABASE e0db_verify;"
docker exec <pg-container> pg_restore -U postgres -d e0db_verify --no-owner --role=postgres /tmp/e0db.dump
```

Phase 5 reference: `pg_restore` took **39 s**, exit 0, no errors.

Checklist against `e0db_verify` (all confirmed in Phase 5):

```
-- row counts match the source at dump time
SELECT (SELECT count(*) FROM employees), (SELECT count(*) FROM documents),
       (SELECT count(*) FROM tenants),   (SELECT count(*) FROM audit_events);

-- RLS still armed on every tenant-owned table (t / t), tenants still f / f
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
WHERE relkind='r' AND relname IN
  ('employees','documents','audit_events','idempotency_keys','expiry_policies','tenants');

-- all 8 tenant_isolation_* policies present
SELECT tablename, policyname FROM pg_policies ORDER BY 1;

-- audit_events is still append-only for app_user (SELECT + INSERT, nothing else)
SELECT privilege_type FROM information_schema.role_table_grants
WHERE table_name='audit_events' AND grantee='app_user';

-- RLS actually ENFORCES (not just present): as app_user, tenant A sees only A,
-- and no tenant context sees nothing
SET ROLE app_user;
BEGIN;
  SELECT set_config('app.current_tenant_id','<tenant-A-uuid>', true);
  SELECT count(*) FROM employees;              -- only tenant A's rows
  SELECT set_config('app.current_tenant_id','', true);
  SELECT count(*) FROM employees;              -- MUST be 0
COMMIT;
RESET ROLE;

DROP DATABASE e0db_verify;
```

If any check fails, the dump is bad — do not delete the previous known-good
backup.

## 3. Real restore (disaster recovery)

Only when `e0db` is actually lost or corrupt.

1. **Stop the API and worker first** (graceful, SIGTERM — E5 Pillar 1):
   ```
   docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production stop api worker
   ```
   Restoring under a live process races the restore against writes and, on
   this stack, can crash the process outright — the `pg` pool has no
   connection-error handler, so it exits on the connection reset a restore
   causes (Phase 5 finding, E7 fix pending).

2. Ensure the roles exist on the target server (new server only):
   ```
   psql -U postgres -f roles.sql
   ```

3. Restore:
   ```
   psql -U postgres -c "CREATE DATABASE e0db;"
   pg_restore -U postgres -d e0db --no-owner --role=postgres e0db-<timestamp>.dump
   ```
   `--no-owner --role=postgres` because objects in the dump are owned by
   `migration_user`; restoring as `postgres` and letting it re-grant is
   simplest. The `GRANT`/`REVOKE` statements in the dump re-establish
   `app_user`'s limited privileges.

4. Run the step-2 checklist against the restored `e0db`.

5. `ANALYZE;` the whole database — `pg_restore` does not carry planner
   statistics, and without them the first queries will use bad plans
   (Phase 3/4 showed how sensitive the O(n) read paths are to the planner).

6. Restart services and verify:
   ```
   docker compose ... start api worker
   curl -f http://<api-host>:3000/health/ready      # expect 200 {"status":"ready"}
   ```
   Then the authenticated smoke call from `docs/runbooks/deploy.md` step 6.

## 4. Point-in-time / partial data loss

Not supported by this procedure — a `pg_dump` restore loses everything written
after the dump. If only some rows were lost/corrupted and the rest of the DB
is fine, restore into `e0db_verify` (step 2) and copy the specific rows across
by hand as `migration_user`, inside a transaction, with tenant context set —
do not restore the whole database over good data.

## Warning

- A restore **replaces** the target database. Triple-check you are pointed at
  the right server and the right database name before `pg_restore`.
- The dump file contains every tenant's real data. Treat backup files with the
  same access controls as the database — encrypted at rest, access-logged.
- Never restore a production dump into a shared dev/staging database — it puts
  real PII somewhere it should not be.
