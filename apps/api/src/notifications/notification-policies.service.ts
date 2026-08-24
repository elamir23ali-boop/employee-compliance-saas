import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { tenantNotificationPolicies } from '@ecs/database';
import type { AuditContext, UpdateNotificationPolicyDto } from '@ecs/shared';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';
import { AuditService } from '../audit/audit.service';

export type NotificationPolicyRow = typeof tenantNotificationPolicies.$inferSelect;

// Mirrors DocumentsService's DEFAULT_POLICY fallback pattern: no row yet for
// this tenant -> the schema's own column defaults, never a separate source
// of truth. `id`/`updatedAt` are null to signal "not yet customized."
const DEFAULT_NOTIFICATION_POLICY: Omit<NotificationPolicyRow, 'id' | 'tenantId' | 'updatedAt'> & {
  id: null;
  updatedAt: null;
} = {
  id: null,
  updatedAt: null,
  reminderDaysBefore: [90, 60, 30, 14, 7, 1],
  emailFrom: null,
  emailTemplateId: null,
  enabled: true,
};

@Injectable()
export class NotificationPoliciesService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly auditService: AuditService,
  ) {}

  async getOrDefault(tenantId: string): Promise<NotificationPolicyRow | (typeof DEFAULT_NOTIFICATION_POLICY & { tenantId: string })> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(tenantNotificationPolicies)
        .where(eq(tenantNotificationPolicies.tenantId, tenantId))
        .limit(1);
      return rows[0] ?? { ...DEFAULT_NOTIFICATION_POLICY, tenantId };
    });
  }

  async update(
    tenantId: string,
    dto: UpdateNotificationPolicyDto,
    auditContext: AuditContext,
  ): Promise<NotificationPolicyRow> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const existingRows = await tx
        .select()
        .from(tenantNotificationPolicies)
        .where(eq(tenantNotificationPolicies.tenantId, tenantId))
        .limit(1);
      const before = existingRows[0] ?? null;

      const next = {
        reminderDaysBefore: dto.reminderDaysBefore ?? before?.reminderDaysBefore ?? DEFAULT_NOTIFICATION_POLICY.reminderDaysBefore,
        emailFrom: dto.emailFrom ?? before?.emailFrom ?? null,
        emailTemplateId: dto.emailTemplateId ?? before?.emailTemplateId ?? null,
        enabled: dto.enabled ?? before?.enabled ?? DEFAULT_NOTIFICATION_POLICY.enabled,
      };

      const upserted = await tx
        .insert(tenantNotificationPolicies)
        .values({ tenantId, ...next })
        .onConflictDoUpdate({
          target: tenantNotificationPolicies.tenantId,
          set: { ...next, updatedAt: new Date() },
        })
        .returning();
      const after = upserted[0];
      if (!after) {
        throw new Error('Notification policy upsert did not return a row');
      }

      await this.auditService.log(
        tx,
        auditContext,
        'NOTIFICATION_POLICY_UPDATED',
        'notification_policy',
        after.id,
        before,
        after,
        'SUCCESS',
      );

      return after;
    });
  }
}
