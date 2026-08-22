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
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_ADMIN_URL is not set');
  }

  const migrationsDir = path.resolve(__dirname, '..', '..', 'packages', 'database', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Applying ${file}...`);
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
  console.log(`Applied ${files.length} migration file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
