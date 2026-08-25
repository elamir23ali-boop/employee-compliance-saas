import { Worker, Queue } from 'bullmq';
import { subHours } from 'date-fns';
import { and, eq, gte, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { notificationLog, tenants, type Database } from '@ecs/database';
import { shouldAlertOnFailureRate } from './failure-alert-policy';

export const FAILURE_ALERT_SCAN_QUEUE_NAME = 'failure-alert-scans';
export const FAILURE_ALERT_SCAN_JOB_NAME = 'scan-notification-failure-rates';
const HOURLY_SCAN_JOB_ID = 'hourly-failure-alert-scan';

const SCAN_WINDOW_HOURS = 6;

/**
 * Consumes the hourly scan trigger. For each active tenant, opens one
 * tenant-scoped transaction (SET LOCAL app.current_tenant_id, same pattern
 * as reminder-scanner.worker.ts) and aggregates notification_log by status
 * over a trailing window. Unlike the reminder scanner, this does NOT skip
 * tenants whose tenant_notification_policies.enabled is false --
 * observability should reflect ground truth in notification_log regardless
 * of current policy state. Emits one structured, PII-free console.error
 * ALERT line per tenant that crosses the failure-rate gate
 * (shouldAlertOnFailureRate) -- no external channel, no dedup/silencing
 * across scans; see docs/architecture/decisions.md (ADR-031) for why.
 */
export function createFailureAlertScanner(db: Database, connection: IORedis): Worker {
  return new Worker(
    FAILURE_ALERT_SCAN_QUEUE_NAME,
    async () => {
      const activeTenants = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
      const windowStart = subHours(new Date(), SCAN_WINDOW_HOURS);

      for (const tenant of activeTenants) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`);

          const stillActive = await tx
            .select({ id: tenants.id })
            .from(tenants)
            .where(and(eq(tenants.id, tenant.id), eq(tenants.status, 'active')));
          if (stillActive.length === 0) return;

          const rows = await tx
            .select({ status: notificationLog.status, count: sql<number>`count(*)::int` })
            .from(notificationLog)
            .where(and(eq(notificationLog.tenantId, tenant.id), gte(notificationLog.sentAt, windowStart)))
            .groupBy(notificationLog.status);

          let sentCount = 0;
          let failedCount = 0;
          for (const row of rows) {
            if (row.status === 'SENT') sentCount = row.count;
            else if (row.status === 'FAILED') failedCount = row.count;
          }

          if (shouldAlertOnFailureRate({ sentCount, failedCount })) {
            const totalAttempts = sentCount + failedCount;
            console.error(
              JSON.stringify({
                action: 'notification_failure_rate_alert',
                tenantId: tenant.id.substring(0, 8),
                windowHours: SCAN_WINDOW_HOURS,
                failedCount,
                totalAttempts,
                failureRate: failedCount / totalAttempts,
              }),
            );
          }
        });
      }

      console.log(
        JSON.stringify({ action: 'failure_alert_scan_completed', tenantCount: activeTenants.length }),
      );
    },
    { connection, concurrency: 1 },
  );
}

/** Registers the repeatable hourly scan trigger once. Idempotent: BullMQ dedups repeatable jobs by their (name, repeat options, jobId). */
export async function scheduleFailureAlertScans(connection: IORedis): Promise<Queue> {
  const scanQueue = new Queue(FAILURE_ALERT_SCAN_QUEUE_NAME, { connection });
  await scanQueue.add(
    FAILURE_ALERT_SCAN_JOB_NAME,
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: HOURLY_SCAN_JOB_ID },
  );
  return scanQueue;
}
