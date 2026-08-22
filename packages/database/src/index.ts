import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export * from './schema';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Constructs a pg Pool + Drizzle instance from the given pool config.
 * Callers own the credentials -- this never assumes app_user vs migration_user.
 * Application runtime code must only ever pass app_user credentials here;
 * migration_user is reserved for migration/perf-diagnostic tooling. See
 * CLAUDE.md ("NEVER use migration_user in application runtime code").
 */
export function createDb(config: PoolConfig): { pool: Pool; db: Database } {
  const pool = new Pool(config);
  const db = drizzle(pool, { schema });
  return { pool, db };
}
