import { sql } from 'drizzle-orm';
import type { DbTransaction } from '@ecs/database';

/**
 * SET LOCAL tenant context for the current transaction only (via
 * set_config(..., true)) -- resets automatically on COMMIT/ROLLBACK, never
 * leaks across pooled connections/requests. See ADR-003 for why RLS
 * policies guard this with NULLIF. NEVER call this outside a transaction,
 * and NEVER cache/store the tenantId anywhere but this per-call parameter.
 */
export async function setTenantContext(tx: DbTransaction, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
}
