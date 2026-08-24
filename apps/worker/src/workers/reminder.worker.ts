import { Worker, type Job } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { z } from 'zod';
import {
  idempotencyKeys,
  tenants,
  documents,
  employees,
  notificationLog,
  tenantNotificationPolicies,
  type Database,
} from '@ecs/database';
import { LogEmailDispatcher, type EmailDispatcher } from '../notifications/email-dispatcher';

const reminderJobSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  daysBeforeExpiry: z.number().int().positive(),
  jobId: z.string(),
  idempotencyKey: z.string(),
});

export const REMINDER_QUEUE_NAME = 'reminders';
export const SEND_REMINDER_JOB = 'send-reminder';

// Mirrors NotificationPoliciesService's DEFAULT_NOTIFICATION_POLICY fallback
// -- duplicated here since apps/worker has no dependency on apps/api
// (ADR-017: each process constructs its own DB handle independently).
const DEFAULT_POLICY = { emailFrom: null as string | null, emailTemplateId: null as string | null };

/**
 * Dispatches a single reminder for one (documentId, daysBeforeExpiry) pair.
 *
 * Idempotency key is claimed only on a terminal outcome (SENT/SUPPRESSED),
 * never on FAILED: if the dispatcher throws, notification_log still gets a
 * FAILED row (so the failure is visible), but no idempotency_keys row is
 * inserted, so the next scheduled scan -- finding no SENT row yet for this
 * threshold -- will naturally re-enqueue and retry. This is deliberate:
 * see docs/architecture/decisions.md (ADR-026) before changing the
 * ordering of the notification_log/idempotency_keys writes below.
 */
export function createReminderWorker(
  db: Database,
  connection: IORedis,
  dispatcher: EmailDispatcher = new LogEmailDispatcher(),
): Worker {
  return new Worker(
    REMINDER_QUEUE_NAME,
    async (job: Job) => {
      const parsed = reminderJobSchema.safeParse(job.data);
      if (!parsed.success) {
        // NEVER process a job without a valid tenantId.
        console.warn(`Discarding job ${job.id}: missing or invalid tenantId`);
        await job.discard();
        throw new Error('Job rejected: missing or invalid tenantId');
      }
      const { tenantId, documentId, daysBeforeExpiry, idempotencyKey } = parsed.data;

      await db.transaction(async (tx) => {
        // SET LOCAL: scoped to this transaction, never a global/module variable.
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
              action: 'reminder_already_processed',
            }),
          );
          return;
        }

        const docRows = await tx
          .select({ documentId: documents.id, employeeEmail: employees.email })
          .from(documents)
          .leftJoin(employees, eq(documents.employeeId, employees.id))
          .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId), isNull(documents.deletedAt)))
          .limit(1);
        const doc = docRows[0];

        if (!doc) {
          await tx.insert(notificationLog).values({
            tenantId,
            documentId,
            daysBeforeExpiry,
            status: 'SUPPRESSED',
            errorMessage: 'document_not_found',
          });
          await tx.insert(idempotencyKeys).values({ key: idempotencyKey, tenantId });
          console.log(
            JSON.stringify({ jobId: job.id, tenantId: tenantId.substring(0, 8), action: 'reminder_suppressed' }),
          );
          return;
        }

        if (!doc.employeeEmail) {
          await tx.insert(notificationLog).values({
            tenantId,
            documentId,
            daysBeforeExpiry,
            status: 'SUPPRESSED',
            errorMessage: 'no_email_on_file',
          });
          await tx.insert(idempotencyKeys).values({ key: idempotencyKey, tenantId });
          console.log(
            JSON.stringify({ jobId: job.id, tenantId: tenantId.substring(0, 8), action: 'reminder_suppressed' }),
          );
          return;
        }

        const policyRows = await tx
          .select()
          .from(tenantNotificationPolicies)
          .where(eq(tenantNotificationPolicies.tenantId, tenantId))
          .limit(1);
        const policy = policyRows[0] ?? DEFAULT_POLICY;

        try {
          await dispatcher.send({
            to: doc.employeeEmail,
            documentId,
            daysBeforeExpiry,
            emailFrom: policy.emailFrom,
            emailTemplateId: policy.emailTemplateId,
          });
          await tx.insert(notificationLog).values({ tenantId, documentId, daysBeforeExpiry, status: 'SENT' });
          await tx.insert(idempotencyKeys).values({ key: idempotencyKey, tenantId });
          console.log(
            JSON.stringify({ jobId: job.id, tenantId: tenantId.substring(0, 8), action: 'reminder_processed' }),
          );
        } catch (err) {
          // Never rethrow: a failed dispatch must not block the transaction
          // or trigger an immediate BullMQ retry storm. No idempotency key
          // is claimed, so the next daily scan retries this threshold.
          await tx.insert(notificationLog).values({
            tenantId,
            documentId,
            daysBeforeExpiry,
            status: 'FAILED',
            errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          });
          console.error(
            JSON.stringify({ jobId: job.id, tenantId: tenantId.substring(0, 8), action: 'reminder_dispatch_failed' }),
          );
        }
      });
    },
    { connection, concurrency: 5 },
  );
}
