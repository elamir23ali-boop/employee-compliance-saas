import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export * from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Constructs a pg Pool + Drizzle instance from the given pool config.
 * Callers own the credentials -- this never assumes app_user vs migration_user.
 * Application runtime code must only ever pass app_user credentials here;
 * migration_user is reserved for migration/perf-diagnostic tooling. See
 * CLAUDE.md ("NEVER use migration_user in application runtime code").
 */
export function createDb(config: PoolConfig): { pool: Pool; db: Database } {
  const pool = new Pool(config);
  // pg-pool re-emits a backend-terminated error on an idle client (Postgres
  // restart, failover, pg_terminate_backend, server-side idle timeout) as an
  // 'error' event on the pool. With no listener, Node's default is to throw,
  // which crashes the process -- confirmed in E6 chaos testing (ADR-037):
  // both apps/api and apps/worker died on a single idle-connection kill.
  // This listener is exactly what the node-postgres docs prescribe: the pool
  // discards the dead client and keeps serving from the rest, so an
  // in-flight query against that client still rejects normally (existing
  // callers already handle DB errors) -- only the process-level crash stops.
  pool.on('error', (err: Error) => {
    console.error(JSON.stringify({ action: 'db_pool_error', message: err.message }));
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
