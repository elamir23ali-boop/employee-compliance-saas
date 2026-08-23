import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { documents, employees, expiryPolicies, ExpiryStatus, type DbTransaction } from '@ecs/database';
import type { AuditContext, CreateDocumentDto, UpdateDocumentDto } from '@ecs/shared';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import { ExpiryService, type ExpiryPolicyRow } from '../expiry/expiry.service';

export type DocumentRow = typeof documents.$inferSelect;

export interface DocumentSearchParams {
  docType?: string | undefined;
  expiryStatus?: ExpiryStatus | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

const DEFAULT_POLICY: Pick<
  ExpiryPolicyRow,
  'warningDays1' | 'warningDays2' | 'warningDays3' | 'criticalDays' | 'gracePeriodDays' | 'autoBlock'
> = {
  warningDays1: 90,
  warningDays2: 60,
  warningDays3: 30,
  criticalDays: 14,
  gracePeriodDays: 0,
  autoBlock: false,
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly auditService: AuditService,
    private readonly expiryService: ExpiryService,
  ) {}

  private async loadPolicy(tx: DbTransaction, tenantId: string, docType: string) {
    const rows = await tx
      .select()
      .from(expiryPolicies)
      .where(and(eq(expiryPolicies.tenantId, tenantId), eq(expiryPolicies.docType, docType)))
      .limit(1);
    return rows[0] ?? DEFAULT_POLICY;
  }

  async create(
    tenantId: string,
    employeeId: string,
    dto: CreateDocumentDto,
    auditContext: AuditContext,
  ): Promise<DocumentRow> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const employeeRows = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.id, employeeId), isNull(employees.deletedAt)))
        .limit(1);
      if (!employeeRows[0]) {
        throw new NotFoundException('Employee not found');
      }

      const policy = await this.loadPolicy(tx, tenantId, dto.docType);
      const expiryStatus = this.expiryService.calculateStatus(
        dto.expiryDate ?? null,
        policy,
        ExpiryStatus.VALID,
      );

      const inserted = await tx
        .insert(documents)
        .values({
          tenantId,
          employeeId,
          docType: dto.docType,
          docNumber: dto.docNumber,
          issueDate: dto.issueDate ?? null,
          expiryDate: dto.expiryDate ?? null,
          expiryStatus,
        })
        .returning();
      const created = inserted[0];
      if (!created) {
        throw new Error('Document insert did not return a row');
      }

      await this.auditService.log(
        tx,
        auditContext,
        'DOCUMENT_CREATED',
        'document',
        created.id,
        null,
        created,
        'SUCCESS',
      );

      return created;
    });
  }

  async findAllForEmployee(tenantId: string, employeeId: string): Promise<DocumentRow[]> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return tx
        .select()
        .from(documents)
        .where(and(eq(documents.employeeId, employeeId), isNull(documents.deletedAt)));
    });
  }

  async findAll(tenantId: string, params: DocumentSearchParams): Promise<{ data: DocumentRow[]; total: number }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;

    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const conditions = [isNull(documents.deletedAt)];
      if (params.docType) conditions.push(eq(documents.docType, params.docType));
      if (params.expiryStatus) conditions.push(eq(documents.expiryStatus, params.expiryStatus));
      const whereClause = and(...conditions);

      const rows = await tx
        .select()
        .from(documents)
        .where(whereClause)
        .orderBy(documents.createdAt)
        .limit(limit)
        .offset((page - 1) * limit);

      const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(documents).where(whereClause);
      const total = countRows[0]?.count ?? 0;

      return { data: rows, total };
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateDocumentDto,
    auditContext: AuditContext,
  ): Promise<DocumentRow> {
    if (dto.expiryStatus === 'EXCEPTION' && !dto.exceptionReason) {
      throw new BadRequestException({
        fieldErrors: { exceptionReason: ['exceptionReason is required when expiryStatus is EXCEPTION'] },
      });
    }

    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const existingRows = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .limit(1);
      const before = existingRows[0];
      if (!before) {
        throw new NotFoundException('Document not found');
      }

      const nextExpiryDate = dto.expiryDate ?? before.expiryDate;
      const manualOverride = dto.expiryStatus;
      let nextExpiryStatus: ExpiryStatus;
      const nextRenewalStartedAt =
        manualOverride === ExpiryStatus.RENEWAL_IN_PROGRESS ? sql`now()` : before.renewalStartedAt;

      if (manualOverride) {
        nextExpiryStatus = manualOverride;
      } else {
        const policy = await this.loadPolicy(tx, tenantId, before.docType);
        nextExpiryStatus = this.expiryService.calculateStatus(
          nextExpiryDate,
          policy,
          before.expiryStatus as ExpiryStatus,
        );
      }

      const updatedRows = await tx
        .update(documents)
        .set({
          docNumber: dto.docNumber ?? before.docNumber,
          issueDate: dto.issueDate ?? before.issueDate,
          expiryDate: nextExpiryDate,
          expiryStatus: nextExpiryStatus,
          exceptionReason: manualOverride === 'EXCEPTION' ? (dto.exceptionReason ?? null) : before.exceptionReason,
          renewalStartedAt: nextRenewalStartedAt,
          version: before.version + 1,
        })
        .where(and(eq(documents.id, id), eq(documents.version, dto.version), isNull(documents.deletedAt)))
        .returning();

      const after = updatedRows[0];
      if (!after) {
        throw new ConflictException({ message: 'Document was modified by another request', detail: 'version_mismatch' });
      }

      await this.auditService.log(
        tx,
        auditContext,
        'DOCUMENT_UPDATED',
        'document',
        id,
        before,
        after,
        'SUCCESS',
        manualOverride ? dto.exceptionReason ?? `manual override: ${manualOverride}` : undefined,
      );
      if (before.expiryStatus !== after.expiryStatus) {
        await this.auditService.log(
          tx,
          auditContext,
          'EXPIRY_STATUS_CHANGED',
          'document',
          id,
          { expiryStatus: before.expiryStatus },
          { expiryStatus: after.expiryStatus },
          'SUCCESS',
        );
      }

      return after;
    });
  }

  async archive(tenantId: string, id: string, auditContext: AuditContext): Promise<{ id: string; archivedAt: string }> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const existingRows = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .limit(1);
      const before = existingRows[0];
      if (!before) {
        throw new NotFoundException('Document not found');
      }

      const updatedRows = await tx
        .update(documents)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .returning();
      const after = updatedRows[0];
      if (!after) {
        throw new NotFoundException('Document not found');
      }

      await this.auditService.log(tx, auditContext, 'DOCUMENT_ARCHIVED', 'document', id, before, after, 'SUCCESS');

      return { id: after.id, archivedAt: (after.deletedAt as unknown as Date).toISOString() };
    });
  }
}
