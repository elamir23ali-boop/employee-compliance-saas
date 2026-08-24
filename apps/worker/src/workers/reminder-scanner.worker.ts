import { Worker, Queue } from 'bullmq';
import { differenceInCalendarDays } from 'date-fns';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import {
  documents,
  tenants,
  tenantNotificationPolicies,
  notificationLog,
  ExpiryStatus,
  type Database,
} from '@ecs/database';
import { matchReminderThreshold } from './reminder-policy';
import { SEND_REMINDER_JOB } from './reminder.worker';

export const REMINDER_SCAN_QUEUE_NAME = 'reminder-scans';
export const SCAN_JOB_NAME = 'scan-expiring-documents';
const DAILY_SCAN_JOB_ID = 'daily-reminder-scan';

// Mirrors the API-side DEFAULT_NOTIFICATION_POLICY fallback -- duplicated
// here (not imported from apps/api) since apps/worker has no dependency on
// apps/api, exactly as both processes already each construct their own
// createDb() per ADR-017.
const DEFAULT_REMINDER_DAYS_BEFORE = [90, 60, 30, 14, 7, 1];

/**
 * Consumes the daily scan trigger. For each active tenant, opens one
 * tenant-scoped transaction (SET LOCAL app.current_tenant_id, never a
 * bare cross-tenant read on an RLS-protected table -- see ADR-003/CLAUDE.md),
 * finds documents crossing a configured reminder threshold today, and
 * enqueues one PII-free send-reminder job per match. Dedup against
 * already-sent reminders happens here (via notification_log) so the
 * queue is never asked to reprocess a threshold that already succeeded.
 */
export function createReminderScanner(db: Database, sendReminderQueue: Queue, connection: IORedis): Worker {
  return new Worker(
    REMINDER_SCAN_QUEUE_NAME,
    async () => {
      const activeTenants = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));

      for (const tenant of activeTenants) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`);

          const stillActive = await tx
            .select({ id: tenants.id })
            .from(tenants)
            .where(and(eq(tenants.id, tenant.id), eq(tenants.status, 'active')));
          if (stillActive.length === 0) return;

          const policyRows = await tx
            .select()
            .from(tenantNotificationPolicies)
            .where(eq(tenantNotificationPolicies.tenantId, tenant.id))
            .limit(1);
          const policy = policyRows[0];
          if (policy && !policy.enabled) return;
          const reminderDaysBefore = policy?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS_BEFORE;

          const candidates = await tx
            .select({ id: documents.id, expiryDate: documents.expiryDate })
            .from(documents)
            .where(
              and(
                eq(documents.tenantId, tenant.id),
                isNull(documents.deletedAt),
                isNotNull(documents.expiryDate),
                eq(documents.expiryStatus, ExpiryStatus.EXPIRING_SOON),
              ),
            );

          const today = new Date();
          for (const doc of candidates) {
            if (!doc.expiryDate) continue;
            const daysUntilExpiry = differenceInCalendarDays(new Date(doc.expiryDate), today);
            const threshold = matchReminderThreshold(daysUntilExpiry, reminderDaysBefore);
            if (threshold === null) continue;

            const alreadySent = await tx
              .select({ id: notificationLog.id })
              .from(notificationLog)
              .where(
                and(
                  eq(notificationLog.documentId, doc.id),
                  eq(notificationLog.daysBeforeExpiry, threshold),
                  eq(notificationLog.status, 'SENT'),
                ),
              )
              .limit(1);
            if (alreadySent.length > 0) continue;

            const idempotencyKey = `reminder:${doc.id}:${threshold}`;
            await sendReminderQueue.add(SEND_REMINDER_JOB, {
              tenantId: tenant.id,
              documentId: doc.id,
              daysBeforeExpiry: threshold,
              jobId: `${doc.id}:${threshold}`,
              idempotencyKey,
            });
          }
        });
      }

      console.log(
        JSON.stringify({ action: 'reminder_scan_completed', tenantCount: activeTenants.length }),
      );
    },
    { connection, concurrency: 1 },
  );
}

/** Registers the repeatable daily scan trigger once. Idempotent: BullMQ dedups repeatable jobs by their (name, repeat options, jobId). */
export async function scheduleReminderScans(connection: IORedis): Promise<Queue> {
  const scanQueue = new Queue(REMINDER_SCAN_QUEUE_NAME, { connection });
  await scanQueue.add(
    SCAN_JOB_NAME,
    {},
    { repeat: { pattern: '0 6 * * *' }, jobId: DAILY_SCAN_JOB_ID },
  );
  return scanQueue;
}
