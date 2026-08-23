import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { employees } from '@ecs/database';
import type { AuditContext, CreateEmployeeDto, EmployeeSearchParams, UpdateEmployeeDto } from '@ecs/shared';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';
import { AuditService } from '../audit/audit.service';

export type EmployeeRow = typeof employees.$inferSelect;

export interface FindAllResult {
  data: EmployeeRow[];
  total: number;
}

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  // drizzle-orm wraps the driver error in DrizzleQueryError, with the
  // original pg error (carrying .code) on `.cause` -- check both so this
  // works whether the raw pg error or Drizzle's wrapper reaches us.
  const direct = (err as { code?: string }).code;
  const causeCode = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || causeCode === PG_UNIQUE_VIOLATION;
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly auditService: AuditService,
  ) {}

  async findAll(tenantId: string, params: EmployeeSearchParams): Promise<FindAllResult> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;

    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const conditions = [isNull(employees.deletedAt)];
      if (params.department) conditions.push(eq(employees.department, params.department));
      if (params.branch) conditions.push(eq(employees.branch, params.branch));
      if (params.status) conditions.push(eq(employees.status, params.status));
      if (params.q) {
        conditions.push(
          sql`to_tsvector('english',
              coalesce(${employees.employeeCode}, '') || ' ' ||
              coalesce(${employees.firstName}, '') || ' ' ||
              coalesce(${employees.lastName}, '') || ' ' ||
              coalesce(${employees.department}, ''))
            @@ plainto_tsquery('english', ${params.q})`,
        );
      }
      const whereClause = and(...conditions);

      const rows = await tx
        .select()
        .from(employees)
        .where(whereClause)
        .orderBy(employees.createdAt)
        .limit(limit)
        .offset((page - 1) * limit);

      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(employees)
        .where(whereClause);
      const total = countRows[0]?.count ?? 0;

      return { data: rows, total };
    });
  }

  async findOne(tenantId: string, id: string): Promise<EmployeeRow> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
        .limit(1);
      const employee = rows[0];
      if (!employee) {
        throw new NotFoundException('Employee not found');
      }
      return employee;
    });
  }

  async create(tenantId: string, dto: CreateEmployeeDto, auditContext: AuditContext): Promise<EmployeeRow> {
    const fullName = `${dto.firstName} ${dto.lastName}`.trim();

    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      let created: EmployeeRow;
      try {
        const inserted = await tx
          .insert(employees)
          .values({
            tenantId,
            employeeCode: dto.employeeCode,
            fullName,
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email ?? null,
            department: dto.department ?? null,
            jobTitle: dto.jobTitle ?? null,
            branch: dto.branch ?? null,
            responsibleOfficerId: dto.responsibleOfficerId ?? null,
          })
          .returning();
        const insertedRow = inserted[0];
        if (!insertedRow) {
          throw new Error('Employee insert did not return a row');
        }
        created = insertedRow;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({ message: 'Employee code already exists', detail: 'duplicate_code' });
        }
        throw err;
      }

      await this.auditService.log(
        tx,
        auditContext,
        'EMPLOYEE_CREATED',
        'employee',
        created.id,
        null,
        created,
        'SUCCESS',
      );

      return created;
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateEmployeeDto,
    auditContext: AuditContext,
  ): Promise<EmployeeRow> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const existingRows = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
        .limit(1);
      const before = existingRows[0];
      if (!before) {
        throw new NotFoundException('Employee not found');
      }

      const firstName = dto.firstName ?? before.firstName ?? '';
      const lastName = dto.lastName ?? before.lastName ?? '';
      const fullName = `${firstName} ${lastName}`.trim() || before.fullName;

      const updatedRows = await tx
        .update(employees)
        .set({
          firstName: dto.firstName ?? before.firstName,
          lastName: dto.lastName ?? before.lastName,
          fullName,
          email: dto.email ?? before.email,
          department: dto.department ?? before.department,
          jobTitle: dto.jobTitle ?? before.jobTitle,
          branch: dto.branch ?? before.branch,
          responsibleOfficerId: dto.responsibleOfficerId ?? before.responsibleOfficerId,
          version: before.version + 1,
        })
        .where(and(eq(employees.id, id), eq(employees.version, dto.version), isNull(employees.deletedAt)))
        .returning();

      const after = updatedRows[0];
      if (!after) {
        throw new ConflictException({ message: 'Employee was modified by another request', detail: 'version_mismatch' });
      }

      await this.auditService.log(tx, auditContext, 'EMPLOYEE_UPDATED', 'employee', id, before, after, 'SUCCESS');

      return after;
    });
  }

  async archive(tenantId: string, id: string, auditContext: AuditContext): Promise<{ id: string; archivedAt: string }> {
    return this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      const existingRows = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
        .limit(1);
      const before = existingRows[0];
      if (!before) {
        throw new NotFoundException('Employee not found');
      }

      const updatedRows = await tx
        .update(employees)
        .set({ deletedAt: sql`now()`, status: 'archived' })
        .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
        .returning();
      const after = updatedRows[0];
      if (!after) {
        throw new NotFoundException('Employee not found');
      }

      await this.auditService.log(tx, auditContext, 'EMPLOYEE_ARCHIVED', 'employee', id, before, after, 'SUCCESS');

      return { id: after.id, archivedAt: (after.deletedAt as unknown as Date).toISOString() };
    });
  }
}
