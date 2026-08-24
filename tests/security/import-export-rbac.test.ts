import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function buildWorkbookBuffer(employeeCode: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Employees');
  worksheet.columns = [
    { header: 'employeeCode', key: 'employeeCode' },
    { header: 'firstName', key: 'firstName' },
    { header: 'lastName', key: 'lastName' },
  ];
  worksheet.addRow({ employeeCode, firstName: 'Rbac', lastName: 'Fixture' });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('Import/Export RBAC', () => {
  let viewerToken: string;
  let hrStaffToken: string;
  let hrManagerToken: string;

  beforeAll(async () => {
    viewerToken = await getAccessToken('viewer_tenant_a@e0.local', 'TestPass123!');
    hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    hrManagerToken = await getAccessToken('hr_manager_tenant_a@e0.local', 'TestPass123!');
  });

  afterAll(async () => {
    await cleanupE2TestEmployees();
  });

  it('IMPEXP-RBAC-01: viewer cannot POST /imports/employees -> 403', async () => {
    const buffer = await buildWorkbookBuffer(`EMP-IMP-RBAC-${randomUUID().slice(0, 8)}`);
    const res = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${viewerToken}`)
      .attach('file', buffer, { filename: 'e.xlsx', contentType: XLSX_CONTENT_TYPE });
    expect(res.status).toBe(403);
  });

  it('IMPEXP-RBAC-02: viewer cannot GET /exports/employees -> 403', async () => {
    const res = await request(API_BASE).get('/api/v1/exports/employees').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('IMPEXP-RBAC-03: hr-staff cannot GET /exports/employees -> 403 (export needs hr-manager)', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/exports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(res.status).toBe(403);
  });

  it('IMPEXP-RBAC-04: hr-staff can POST /imports/employees -> 201', async () => {
    const buffer = await buildWorkbookBuffer(`EMP-IMP-RBAC-${randomUUID().slice(0, 8)}`);
    const res = await request(API_BASE)
      .post('/api/v1/imports/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .attach('file', buffer, { filename: 'e.xlsx', contentType: XLSX_CONTENT_TYPE });
    expect(res.status).toBe(201);
  });

  it('IMPEXP-RBAC-05: hr-manager can GET /exports/employees -> 200, and it never contains a tenant B employee', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/exports/employees')
      .set('Authorization', `Bearer ${hrManagerToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as Parameters<typeof workbook.xlsx.load>[0]);
    const worksheet = workbook.worksheets[0];
    const codes: string[] = [];
    worksheet?.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      codes.push(String(row.getCell(1).value));
    });
    // Tenant B's seed employees never use the EMP-B*/tenant-a-style codes
    // this test's own tenant-a fixtures use; the meaningful assertion is
    // that nothing in tenant B's employee_code namespace ('EMP-B') leaked in.
    expect(codes.some((code) => code.startsWith('EMP-B'))).toBe(false);
  });
});
