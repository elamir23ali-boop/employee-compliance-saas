import { Injectable } from '@nestjs/common';
import { addDays, formatISO } from 'date-fns';
import { and, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { documents, ExpiryStatus } from '@ecs/database';
import type { DashboardSummary, DocumentStatsRow, DocumentType } from '@ecs/shared';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';

export type DocumentRow = typeof documents.$inferSelect;

export interface ExpiringDocumentsParams {
  withinDays?: number | undefined;
  docType?: DocumentType | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

const ALL_EXPIRY_STATUSES = Object.values(ExpiryStatus);

@Injectable()
export class DashboardService {
  constructor(private readonly drizzle: DrizzleService) {}

  async getSummary(tenantId: string): Promise<DashboardSummary> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const rows = await tx
        .select({ expiryStatus: documents.expiryStatus, count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), isNull(documents.deletedAt)))
        .groupBy(documents.expiryStatus);

      const byStatus = Object.fromEntries(ALL_EXPIRY_STATUSES.map((status) => [status, 0])) as Record<
        ExpiryStatus,
        number
      >;
      let totalDocuments = 0;
      for (const row of rows) {
        byStatus[row.expiryStatus] = row.count;
        totalDocuments += row.count;
      }

      return { totalDocuments, byStatus };
    });
  }

  async getDocumentStats(tenantId: string): Promise<DocumentStatsRow[]> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const rows = await tx
        .select({ docType: documents.docType, expiryStatus: documents.expiryStatus, count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), isNull(documents.deletedAt)))
        .groupBy(documents.docType, documents.expiryStatus);

      return rows.map((row) => ({
        docType: row.docType as DocumentType,
        expiryStatus: row.expiryStatus,
        count: row.count,
      }));
    });
  }

  async getExpiringDocuments(
    tenantId: string,
    params: ExpiringDocumentsParams,
  ): Promise<{ data: DocumentRow[]; total: number }> {
    const withinDays = params.withinDays ?? 30;
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const today = formatISO(new Date(), { representation: 'date' });
    const windowEnd = formatISO(addDays(new Date(), withinDays), { representation: 'date' });

    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const conditions = [
        eq(documents.tenantId, tenantId),
        isNull(documents.deletedAt),
        isNotNull(documents.expiryDate),
        gte(documents.expiryDate, today),
        lte(documents.expiryDate, windowEnd),
      ];
      if (params.docType) conditions.push(eq(documents.docType, params.docType));
      const whereClause = and(...conditions);

      const rows = await tx
        .select()
        .from(documents)
        .where(whereClause)
        .orderBy(documents.expiryDate)
        .limit(limit)
        .offset((page - 1) * limit);

      const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(documents).where(whereClause);
      const total = countRows[0]?.count ?? 0;

      return { data: rows, total };
    });
  }
}
