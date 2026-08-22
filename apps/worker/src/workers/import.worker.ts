import { Worker, type Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { z } from 'zod';
import { idempotencyKeys, tenants, type Database } from '@ecs/database';

const importJobSchema = z.object({
  tenantId: z.string().uuid(),
  jobId: z.string(),
  idempotencyKey: z.string(),
  rowCount: z.number().int().nonnegative(),
});

export const IMPORT_QUEUE_NAME = 'imports';
export const PROCESS_IMPORT_JOB = 'process-import';

export function createImportWorker(db: Database, connection: IORedis): Worker {
  return new Worker(
    IMPORT_QUEUE_NAME,
    async (job: Job) => {
      const parsed = importJobSchema.safeParse(job.data);
      if (!parsed.success) {
        // NEVER process a job without a valid tenantId.
        console.warn(`Discarding job ${job.id}: missing or invalid tenantId`);
        await job.discard();
        throw new Error('Job rejected: missing or invalid tenantId');
      }
      const { tenantId, idempotencyKey } = parsed.data;

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);

        const tenantRows = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(and(eq(tenants.id, tenantId), eq(tenants.status, 'active')));
        if (tenantRows.length === 0) {
          throw new Error('Tenant not active or not found');
        }

        const existing = await tx
          .select({ key: idempotencyKeys.key })
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, idempotencyKey));
        if (existing.length > 0) {
          console.log(
            JSON.stringify({
              jobId: job.id,
              tenantId: tenantId.substring(0, 8),
              action: 'import_already_processed',
            }),
          );
          return;
        }

        await tx.insert(idempotencyKeys).values({ key: idempotencyKey, tenantId });
        console.log(JSON.stringify({ jobId: job.id, tenantId: tenantId.substring(0, 8), action: 'import_processed' }));
      });
    },
    { connection, concurrency: 5 },
  );
}
