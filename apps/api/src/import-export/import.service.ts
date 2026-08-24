import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { and, eq, sql } from 'drizzle-orm';
import { employees, importBatches } from '@ecs/database';
import type { AuditContext, CreateEmployeeDto, ImportRowError } from '@ecs/shared';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import { EmployeesService } from '../employees/employees.service';
import { ImportQueueService } from './import-queue.service';
import { buildRowRecord, parseEmployeeImportRow } from './employee-row';

export type ImportBatchRow = typeof importBatches.$inferSelect;

const REQUIRED_HEADERS = ['employeeCode', 'firstName', 'lastName'];
const MAX_IMPORT_ROWS = 5000;

export interface ImportResult {
  batch: ImportBatchRow;
  errors: ImportRowError[];
}

@Injectable()
export class ImportService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly auditService: AuditService,
    private readonly employeesService: EmployeesService,
    private readonly importQueue: ImportQueueService,
  ) {}

  private async findExistingBatch(tenantId: string, fileHash: string): Promise<ImportBatchRow | null> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.tenantId, tenantId), eq(importBatches.fileHash, fileHash)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  private async parseWorkbook(fileBuffer: Buffer): Promise<{ rowNumber: number; record: Record<string, unknown> }[]> {
    let worksheet: ExcelJS.Worksheet | undefined;
    try {
      const workbook = new ExcelJS.Workbook();
      // exceljs's own .d.ts declares a private, unexported `Buffer`
      // interface (extends ArrayBuffer) for this parameter, structurally
      // incompatible with @types/node's real Buffer (extends Uint8Array) --
      // a known exceljs typing quirk, not a real type mismatch (a real Node
      // Buffer is exactly what this API expects at runtime). Since the
      // exceljs type isn't exported, Parameters<> extracts it by structure
      // instead of by name.
      await workbook.xlsx.load(fileBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      worksheet = workbook.worksheets[0];
    } catch {
      throw new BadRequestException('Could not parse the uploaded file as an .xlsx workbook');
    }
    if (!worksheet) {
      throw new BadRequestException('Workbook has no worksheets');
    }

    const headers: string[] = [];
    worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber - 1] = String(cell.value ?? '').trim();
    });
    const missingHeaders = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (missingHeaders.length > 0) {
      throw new BadRequestException(`Missing required column(s): ${missingHeaders.join(', ')}`);
    }

    const rowRecords: { rowNumber: number; record: Record<string, unknown> }[] = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (row.actualCellCount === 0) continue;
      rowRecords.push({ rowNumber, record: buildRowRecord(headers, row.values as ExcelJS.CellValue[]) });
    }
    if (rowRecords.length === 0) {
      throw new BadRequestException('Workbook has no data rows');
    }
    if (rowRecords.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(`File has ${rowRecords.length} rows, exceeding the ${MAX_IMPORT_ROWS}-row limit`);
    }
    return rowRecords;
  }

  /** Reuses EmployeesService.create/update exactly (not a second, drifting write path) -- see ADR-027. */
  private async upsertEmployeeRow(tenantId: string, dto: CreateEmployeeDto, auditContext: AuditContext): Promise<void> {
    const existingRows = await this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return tx
        .select()
        .from(employees)
        .where(and(eq(employees.tenantId, tenantId), eq(employees.employeeCode, dto.employeeCode)))
        .limit(1);
    });
    const existing = existingRows[0];

    if (existing?.deletedAt) {
      throw new Error('employee_code belongs to an archived employee');
    }

    if (existing) {
      await this.employeesService.update(
        tenantId,
        existing.id,
        {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          department: dto.department,
          jobTitle: dto.jobTitle,
          branch: dto.branch,
          responsibleOfficerId: dto.responsibleOfficerId,
          version: existing.version,
        },
        auditContext,
      );
    } else {
      await this.employeesService.create(tenantId, dto, auditContext);
    }
  }

  async importEmployees(
    tenantId: string,
    fileBuffer: Buffer,
    actorUserId: string,
    auditContext: AuditContext,
  ): Promise<ImportResult> {
    const fileHash = createHash('sha256').update(fileBuffer).digest('hex');

    const existingBatch = await this.findExistingBatch(tenantId, fileHash);
    if (existingBatch) {
      // Idempotent replay per ADR-025 decision #3 -- no reprocessing, no
      // duplicate employees. Per-row error detail from the original run
      // was never persisted (import_batches stores summary counts only),
      // so a replay's errors array is always empty by design.
      return { batch: existingBatch, errors: [] };
    }

    const rowRecords = await this.parseWorkbook(fileBuffer);

    const inserted = await this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return tx
        .insert(importBatches)
        .values({ tenantId, status: 'PROCESSING', totalRows: rowRecords.length, fileHash, createdBy: actorUserId })
        .returning();
    });
    const batch = inserted[0];
    if (!batch) {
      throw new Error('Import batch insert did not return a row');
    }

    let processedRows = 0;
    const errors: ImportRowError[] = [];

    for (const { rowNumber, record } of rowRecords) {
      const parsed = parseEmployeeImportRow(record);
      const employeeCode = typeof record.employeeCode === 'string' ? record.employeeCode : undefined;
      if ('error' in parsed) {
        errors.push({ row: rowNumber, employeeCode, message: parsed.error });
        continue;
      }
      try {
        await this.upsertEmployeeRow(tenantId, parsed.data, auditContext);
        processedRows += 1;
      } catch (err) {
        errors.push({ row: rowNumber, employeeCode, message: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    const errorRows = errors.length;
    const outcome = errorRows === 0 ? 'SUCCESS' : processedRows === 0 ? 'FAILED' : 'PARTIAL';

    const completedRows = await this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const updated = await tx
        .update(importBatches)
        .set({ status: 'COMPLETED', processedRows, errorRows, completedAt: sql`now()` })
        .where(eq(importBatches.importBatchId, batch.importBatchId))
        .returning();
      await this.auditService.log(
        tx,
        auditContext,
        'IMPORT_BATCH_COMPLETED',
        'import_batch',
        batch.importBatchId,
        null,
        { totalRows: rowRecords.length, processedRows, errorRows },
        outcome,
      );
      return updated;
    });
    const completed = completedRows[0];
    if (!completed) {
      throw new Error('Import batch update did not return a row');
    }

    await this.importQueue.enqueueCompletion({
      tenantId,
      importBatchId: batch.importBatchId,
      rowCount: rowRecords.length,
    });

    return { batch: completed, errors };
  }

  async findBatch(tenantId: string, importBatchId: string): Promise<ImportBatchRow | null> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.importBatchId, importBatchId), eq(importBatches.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }
}
