import { Injectable } from '@nestjs/common';
import { subHours } from 'date-fns';
import { and, eq, gte, sql } from 'drizzle-orm';
import { notificationLog } from '@ecs/database';
import type { NotificationLogStats } from '@ecs/shared';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';

@Injectable()
export class NotificationLogService {
  constructor(private readonly drizzle: DrizzleService) {}

  async getStats(tenantId: string, windowHours: number): Promise<NotificationLogStats> {
    const windowEnd = new Date();
    const windowStart = subHours(windowEnd, windowHours);

    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const rows = await tx
        .select({ status: notificationLog.status, count: sql<number>`count(*)::int` })
        .from(notificationLog)
        .where(and(eq(notificationLog.tenantId, tenantId), gte(notificationLog.sentAt, windowStart)))
        .groupBy(notificationLog.status);

      let sentCount = 0;
      let failedCount = 0;
      let suppressedCount = 0;
      for (const row of rows) {
        if (row.status === 'SENT') sentCount = row.count;
        else if (row.status === 'FAILED') failedCount = row.count;
        else if (row.status === 'SUPPRESSED') suppressedCount = row.count;
      }
      const totalAttempts = sentCount + failedCount;

      return {
        windowHours,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        sentCount,
        failedCount,
        suppressedCount,
        totalAttempts,
        failureRate: totalAttempts === 0 ? null : failedCount / totalAttempts,
      };
    });
  }
}
