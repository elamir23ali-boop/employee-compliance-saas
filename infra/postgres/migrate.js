// E1: bootstraps roles/schema/RLS/seed data against a fresh Postgres database
// by running the SQL migration files (packages/database/migrations) in
// order, as the Postgres superuser. This is what docker-entrypoint-initdb.d
// does automatically for local dev on a fresh volume (see
// infra/docker/docker-compose.yml); this script exists for environments
// where that mechanism isn't available -- e.g. GitHub Actions service
// containers, which don't support mounting local files as init scripts.
//
// NEVER used by application runtime code, and never uses app_user or
// migration_user credentials -- only the Postgres superuser, which owns
// creating those two roles in the first place (see migrations/001_roles.sql).
//
// ADR-039: this used to unconditionally re-run every file on every
// invocation, which only ever worked for a first, fresh bootstrap -- running
// it a second time against an already-migrated database (e.g. this repo's
// own E7 production RDS) would fail on the first already-existing object
// (`CREATE ROLE app_user` when the role already exists, etc). A
// `schema_migrations` table now tracks which files have actually been
// applied, so this script is safe to run repeatedly and only ever applies
// files it hasn't seen before -- see planMigrations() below for the pure
// decision logic (unit-tested directly, tests/unit/migrate-plan.test.ts).
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MARKER_TABLE = 'tenants'; // created by 002_schema.sql -- the earliest migration that isn't just role setup

/**
 * Pure decision logic, no I/O: given what's on disk, what's already tracked,
 * and whether evidence of a pre-existing (untracked) schema exists, decide
 * which files to backfill (mark applied without re-running) vs. actually
 * apply.
 *
 * - Fresh database (nothing tracked, no marker table): backfill nothing,
 *   apply everything -- today's bootstrap behavior, unchanged.
 * - Pre-existing database from before this tracking table existed (nothing
 *   tracked, but the marker table is already there): every file on disk was
 *   already applied together in one shot by the untracked version of this
 *   script -- backfill all of them (record as applied, without re-running
 *   their SQL), apply nothing.
 * - Anything already tracked (this table is non-empty): normal incremental
 *   behavior -- apply only files not yet recorded, in order.
 */
function planMigrations({ filesOnDisk, alreadyApplied, markerTableExists }) {
  const applied = new Set(alreadyApplied);
  let backfill = [];

  if (applied.size === 0 && markerTableExists) {
    backfill = [...filesOnDisk];
    for (const file of backfill) applied.add(file);
  }

  const toApply = filesOnDisk.filter((file) => !applied.has(file));
  return { backfill, toApply };
}

async function tableExists(client, name) {
  const res = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${name}`]);
  return res.rows[0].exists;
}

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_ADMIN_URL is not set');
  }

  const migrationsDir = path.resolve(__dirname, '..', '..', 'packages', 'database', 'migrations');
  const filesOnDisk = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        backfilled BOOLEAN NOT NULL DEFAULT false
      )
    `);

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const { backfill, toApply } = planMigrations({
      filesOnDisk,
      alreadyApplied: rows.map((r) => r.filename),
      markerTableExists: await tableExists(client, MARKER_TABLE),
    });

    if (backfill.length > 0) {
      console.log(
        `schema_migrations is empty but '${MARKER_TABLE}' already exists -- backfilling ${backfill.length} already-applied file(s) without re-running them.`,
      );
      for (const file of backfill) {
        await client.query(
          'INSERT INTO schema_migrations (filename, backfilled) VALUES ($1, true) ON CONFLICT (filename) DO NOTHING',
          [file],
        );
      }
    }

    for (const file of toApply) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(
      `Applied ${toApply.length} new migration file(s) (${filesOnDisk.length} total on disk, ${backfill.length} backfilled, ${filesOnDisk.length - toApply.length - backfill.length} already tracked).`,
    );
  } finally {
    await client.end();
  }
}

module.exports = { planMigrations };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
