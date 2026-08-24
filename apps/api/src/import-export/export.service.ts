import { Injectable } from '@nestjs/common';
import { isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { employees } from '@ecs/database';
import { DrizzleService } from '../database/drizzle.service';
import { setTenantContext } from '../database/tenant-context';

const EXPORT_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'employeeCode', key: 'employeeCode', width: 18 },
  { header: 'firstName', key: 'firstName', width: 18 },
  { header: 'lastName', key: 'lastName', width: 18 },
  { header: 'email', key: 'email', width: 28 },
  { header: 'department', key: 'department', width: 18 },
  { header: 'jobTitle', key: 'jobTitle', width: 18 },
  { header: 'branch', key: 'branch', width: 18 },
  { header: 'responsibleOfficerId', key: 'responsibleOfficerId', width: 22 },
];

@Injectable()
export class ExportService {
  constructor(private readonly drizzle: DrizzleService) {}

  async exportEmployees(tenantId: string): Promise<Buffer> {
    const rows = await this.drizzle.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return tx.select().from(employees).where(isNull(employees.deletedAt));
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Employees');
    worksheet.columns = EXPORT_COLUMNS;
    for (const row of rows) {
      worksheet.addRow({
        employeeCode: row.employeeCode,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        department: row.department,
        jobTitle: row.jobTitle,
        branch: row.branch,
        responsibleOfficerId: row.responsibleOfficerId,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
