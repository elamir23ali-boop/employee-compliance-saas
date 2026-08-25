# Runbook: Rollback a migration

No auto-rollback mechanism exists in this repo -- `packages/database/migrations/`
holds only forward (`up`) SQL files, no paired `down` files, and
`infra/postgres/migrate.js` has no rollback command. This is a manual,
deliberate-slow procedure. If you are not confident about every step below
for the specific migration involved, escalate before running anything --
see the Warning section at the end.

## 1. Identify the migration to roll back

There is no `schema_migrations` tracking table (see
`docs/runbooks/deploy.md`'s own gap note) -- confirm exactly which file was
last applied by cross-referencing:

- `git log -- packages/database/migrations/` on the deployed commit, and
- the actual current schema (`\d <table>` / `information_schema.columns` /
  `pg_indexes` for what that file was supposed to add -- the same
  verification approach `deploy.md` step 3 uses).

## 2. Stop API and worker

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production stop api worker
```

Graceful (SIGTERM, E5 Pillar 1) -- do not `kill -9` / `docker kill`. Do not
skip this: rolling back schema out from under a running process is how you
turn one incident into two.

## 3. Assess: is this migration reversible?

- **Additive-only** (a new table, a new nullable column, a new index --
  e.g. every migration in this repo's history from `009_e3_...sql` onward
  has been additive-only, per ADR-025/ADR-031's own "purely additive" /
  "index-only" consequences sections): reversible. `DROP` the added
  object(s); nothing else referenced them yet if this is a fresh deploy
  being rolled back quickly.
- **Data-transforming, a `DROP`/`ALTER ... NOT NULL` on an existing column,
  or anything that ran for more than a few minutes with real traffic
  against it**: likely irreversible without data loss or a custom
  backfill. **Escalate -- do not proceed past this step alone.** See the
  Warning section.

## 4. Run rollback SQL manually

For a genuinely additive migration, write and run the inverse by hand,
connected as the superuser (matching how the forward migration itself
connects -- see `deploy.md` step 3):

```
psql "<DATABASE_ADMIN_URL>" -c "DROP INDEX IF EXISTS idx_the_new_index;"
psql "<DATABASE_ADMIN_URL>" -c "DROP TABLE IF EXISTS the_new_table;"
-- or, for an added column:
psql "<DATABASE_ADMIN_URL>" -c "ALTER TABLE the_table DROP COLUMN IF EXISTS the_new_column;"
```

There is no scripted/generic rollback -- write the exact inverse of the
specific migration file, nothing templated. If the migration's own SQL
file did anything inside a `SET ROLE migration_user` block (ADR-002), the
rollback should too, for the same ownership reasons.

## 5. Verify DB state

- Row counts on any table the migration touched, before/after, if you
  captured a before count (you should have, per the pre-deploy checklist
  in `deploy.md`).
- Schema check: confirm the dropped object is actually gone
  (`to_regclass(...)` returns `NULL`, or the column no longer appears in
  `information_schema.columns`).
- If RLS was involved in any way (it should never be, for a genuinely
  additive rollback -- if it is, you are past what this runbook covers;
  see Warning), confirm `pg_policies`/`FORCE ROW LEVEL SECURITY` state
  matches what it was before the forward migration, not a partially
  torn-down state.

## 6. Restart services

```
docker compose -f infra/docker/docker-compose.production.yml --env-file .env.production start api worker
```

## 7. Verify

```
curl -f http://<api-host>:3000/health/ready
```

Expect `200 {"status":"ready",...}`. Also re-run the same authenticated
smoke-test call `deploy.md` step 6 describes.

## Warning: when to escalate instead of proceeding

Stop and get a second person (or the original author of the migration, if
identifiable from `git blame`/the commit message) before running anything
in steps 3-4 if any of the following is true:

- The migration is anything other than additive-only (a `DROP COLUMN`, a
  data backfill/transform, a constraint tightening on existing rows, a
  rename).
- Real traffic has been running against the new schema for more than a few
  minutes -- application code may already be writing rows that assume the
  new shape exists, and rolling the schema back out from under it can
  corrupt data rather than just reverting an empty table.
- The migration touched RLS policies, `audit_events`' append-only grants,
  or any table listed under CLAUDE.md's Review Gates -- these carry
  security properties that a rushed manual rollback can silently weaken.
- You are not the person who wrote or reviewed the original migration and
  cannot reconstruct with confidence what its exact inverse is.

A wrong rollback is very often worse than a known-bad forward state left
in place a little longer while you get a second opinion.
