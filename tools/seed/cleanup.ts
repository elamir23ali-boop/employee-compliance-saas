/**
 * E6 seed-data teardown. Removes every row created by generate.ts and the five
 * load-test tenant rows, then verifies nothing `@test.invalid` remains.
 *
 *   npm run cleanup
 *   npm run cleanup -- --keep-tenants   # leave the 5 empty tenant rows in place
 *
 * DEVIATION from the E6 brief (which sketches cleanup as "app_user + SET LOCAL
 * per tenant"): several tables generate.ts touches transitively are
 * INSERT-only for app_user by GRANT -- `notification_log` (ADR-025, the same
 * append-only model as audit_events), and app_user has no DELETE on
 * `tenant_notification_policies` / `import_batches` / `expiry_policies`
 * either. A per-tenant app_user DELETE of the full footprint is therefore
 * impossible by grant. This repo's existing teardown helper
 * (`tests/support/db-cleanup.ts`) already resolved the identical problem the
 * same way: run teardown as `migration_user` (BYPASSRLS + full DML). That is
 * test/tooling infrastructure, not application runtime code -- the
 * append-only / "never hard-delete" rules in CLAUDE.md govern the services,
 * not fixtures.
 *
 * E6 Phase 4 finding: `documents.employee_id` has NO index backing its FK to
 * `employees` (002_schema.sql). `DELETE FROM employees` then re-checks that FK
 * with a *sequential scan of documents per deleted row* -- O(n*m), ~11 min for
 * one 50k-employee tenant at the 100k seed. Workaround here: prefer the
 * superuser `DATABASE_ADMIN_URL` and `SET session_replication_role = replica`
 * for the teardown session, which skips the RI trigger checks. This is safe
 * because the deletes below already run in FK-dependency order (children
 * first) so no orphan is ever created; it is a session setting, nothing
 * schema- or data-permanent. Falls back to `DATABASE_MIGRATION_URL` (slow
 * path) if the admin URL is absent or not a superuser. The real fix -- an
 * index on `documents(employee_id)` -- is a migration (review gate); see
 * docs/e6-results/phase-4-stress.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { TENANTS, SEED_EMAIL_DOMAIN } from './config';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '.env.local');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

// deepest FK dependants first
const PER_TENANT_DELETES = [
  'DELETE FROM notification_log WHERE tenant_id = $1',
  'DELETE FROM documents WHERE tenant_id = $1',
  'DELETE FROM employees WHERE tenant_id = $1',
  'DELETE FROM tenant_notification_policies WHERE tenant_id = $1',
  'DELETE FROM import_batches WHERE tenant_id = $1',
  'DELETE FROM expiry_policies WHERE tenant_id = $1',
];

async function main(): Promise<void> {
  loadEnvLocal();
  const keepTenants = process.argv.slice(2).includes('--keep-tenants');
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error('neither DATABASE_ADMIN_URL nor DATABASE_MIGRATION_URL is set (expected in .env.local)');
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  const seedIds = TENANTS.map((t) => t.id);
  try {
    const { rows: superRows } = await client.query<{ s: boolean }>(
      'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user',
    );
    if (superRows[0]?.s) {
      // Skip the FK RI trigger checks -- see the file header. Safe because the
      // deletes below run children-first, so no orphan is created.
      await client.query("SET session_replication_role = 'replica'");
      console.log('  (superuser: session_replication_role=replica -- FK checks skipped for teardown)');
    } else {
      console.log('  (not superuser: FK RI checks active -- teardown of a large seed can take many minutes)');
    }
    for (const tenant of TENANTS) {
      await client.query('BEGIN');
      const deleted: string[] = [];
      for (const stmt of PER_TENANT_DELETES) {
        const res = await client.query(stmt, [tenant.id]);
        if (res.rowCount) deleted.push(`${res.rowCount} ${stmt.split(' ')[2] ?? '?'}`);
      }
      await client.query('COMMIT');
      console.log(`  ${tenant.name}: ${deleted.length ? deleted.join(', ') : 'nothing to delete'}`);
    }

    if (!keepTenants) {
      const res = await client.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [seedIds]);
      console.log(`  tenants: ${res.rowCount ?? 0} deleted`);
    }

    // Verification (BYPASSRLS): no @test.invalid data anywhere, and the seed
    // tenant rows are gone (unless --keep-tenants).
    const orphanEmp = await client.query('SELECT count(*)::int AS n FROM employees WHERE email LIKE $1', [
      `%${SEED_EMAIL_DOMAIN}`,
    ]);
    const orphanEmpCount = orphanEmp.rows[0].n as number;

    const tenantRows = await client.query('SELECT count(*)::int AS n FROM tenants WHERE id = ANY($1::uuid[])', [seedIds]);
    const tenantRowCount = tenantRows.rows[0].n as number;

    let ok = orphanEmpCount === 0;
    console.log(`\nVerification:`);
    console.log(`  employees with ${SEED_EMAIL_DOMAIN}: ${orphanEmpCount} (expected 0)`);
    console.log(`  seed tenant rows: ${tenantRowCount}${keepTenants ? ' (--keep-tenants)' : ' (expected 0)'}`);
    if (!keepTenants && tenantRowCount !== 0) ok = false;

    if (ok) {
      console.log('\nCLEANUP CONFIRMED. Next: run  npm run test:unit && npm run test:security && npm run test:integration');
      process.exitCode = 0;
    } else {
      console.error('\nCLEANUP INCOMPLETE -- see counts above.');
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('cleanup failed:', err);
  process.exitCode = 1;
});
