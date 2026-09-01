/**
 * Shared connection helpers for the E6 seed tooling.
 *
 * Seeding uses the `app_user` connection (DATABASE_URL) exclusively -- never
 * migration_user. Every write to a tenant-owned table happens inside a
 * transaction that issues `SELECT set_config('app.current_tenant_id', <uuid>,
 * true)` as its first statement (SET LOCAL semantics, ADR-003), so RLS +
 * FORCE RLS is satisfied exactly as it is for real application writes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool, type PoolClient } from 'pg';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

export function appPool(): Pool {
  loadEnvLocal();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set (expected in .env.local)');
  if (/migration_user/.test(connectionString)) {
    throw new Error('DATABASE_URL points at migration_user -- seeding must use app_user');
  }
  return new Pool({ connectionString, max: 4 });
}

/**
 * Run `fn` inside one transaction with tenant context set as the first
 * statement. Commits on success, rolls back on throw.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Parse `--count=N` from argv. Returns undefined when absent. */
export function parseCountArg(argv: string[]): number | undefined {
  for (const arg of argv) {
    const m = /^--count=(\d+)$/.exec(arg);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}
