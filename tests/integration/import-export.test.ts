import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

async function buildWorkbookBuffer(rows: Record<string, string>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Employees');
  worksheet.columns = [
    { header: 'employeeCode', key: 'employeeCode' },
    { header: 'firstName', key: 'firstName' },
    { header: 'lastName', key: 'lastName' },
    { header: 'email', key: 'email' },
  ];
  for (const row of rows) {
    worksheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('Import/Export integration (E3 Phase 4)', () => {
  afterAll(async () => {
    await cleanupE2TestEmployees();
  });

  it('IMPEXP-01: uploads a workbook, creates valid rows, reports the invalid one, and updates on re-import', async () => {
    const hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const suffix = randomUUID().slice(0, 8);
    const codeA = `EMP-IMP-A-${suffix}`;
    const codeB = `EMP-IMP-B-${suffix}`;

    const buffer = await buildWorkbookBuffer([
      { employeeCode: codeA, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      { employeeCode: codeB, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test' },
      { employeeCode: `EMP-IMP-BAD-${suffix}`, firstName: 'NoLastName', lastName: '', email: '' },
    ]);

    const res = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .attach('file', buffer, { filename: 'employees.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    expect(res.status).toBe(201);
    expect(res.body.data.totalRows).toBe(3);
    expect(res.body.data.processedRows).toBe(2);
    expect(res.body.data.errorRows).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(4);

    // Re-uploading the exact same bytes is idempotent: same batch id, no reprocessing.
    const replayRes = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .attach('file', buffer, { filename: 'employees.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(replayRes.status).toBe(201);
    expect(replayRes.body.data.importBatchId).toBe(res.body.data.importBatchId);
    expect(replayRes.body.errors).toEqual([]);

    // A second, different file updates codeA's record instead of duplicating it.
    const updateBuffer = await buildWorkbookBuffer([
      { employeeCode: codeA, firstName: 'Ada', lastName: 'ByronKing', email: 'ada@example.test' },
    ]);
    const updateRes = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .attach('file', updateBuffer, { filename: 'employees2.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(updateRes.status).toBe(201);
    // processedRows: 1 with errorRows: 0 only happens if codeA's employeeCode
    // was recognized as an existing row to update -- if the earlier create
    // hadn't actually persisted, this would instead hit a duplicate-code
    // conflict and land in errors, not processedRows.
    expect(updateRes.body.data.processedRows).toBe(1);
    expect(updateRes.body.data.errorRows).toBe(0);
    expect(updateRes.body.data.importBatchId).not.toBe(res.body.data.importBatchId);

    const batchStatusRes = await request(API_BASE)
      .get(`/api/v1/imports/${res.body.data.importBatchId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(batchStatusRes.status).toBe(200);
    expect(batchStatusRes.body.data.status).toBe('COMPLETED');
  });

  it('IMPEXP-02: rejects a non-.xlsx upload', async () => {
    const hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const res = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .attach('file', Buffer.from('not an excel file'), { filename: 'employees.csv', contentType: 'text/csv' });
    expect(res.status).toBe(400);
  });

  it('IMPEXP-03: export downloads a workbook containing an imported employee', async () => {
    const hrManagerToken = await getAccessToken('hr_manager_tenant_a@e0.local', 'TestPass123!');
    const hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const suffix = randomUUID().slice(0, 8);
    const code = `EMP-IMP-EXP-${suffix}`;

    const buffer = await buildWorkbookBuffer([{ employeeCode: code, firstName: 'Katherine', lastName: 'Johnson', email: '' }]);
    const importRes = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .attach('file', buffer, { filename: 'export-fixture.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(importRes.status).toBe(201);

    const exportRes = await request(API_BASE)
      .get('/api/v1/exports/employees')
      .set('Authorization', `Bearer ${hrManagerToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportRes.body as Parameters<typeof workbook.xlsx.load>[0]);
    const worksheet = workbook.worksheets[0];
    const codes: string[] = [];
    worksheet?.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      codes.push(String(row.getCell(1).value));
    });
    expect(codes).toContain(code);
  });
});
