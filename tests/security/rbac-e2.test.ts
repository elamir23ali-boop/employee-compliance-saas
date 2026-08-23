import { randomUUID } from 'node:crypto';
import { addDays } from 'date-fns';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

async function createEmployee(token: string): Promise<string> {
  const res = await request(API_BASE)
    .post('/api/v1/employees')
    .set('Authorization', `Bearer ${token}`)
    .send({ employeeCode: `EMP-RBAC-${randomUUID().slice(0, 8)}`, firstName: 'Rbac', lastName: 'Fixture' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function createDocument(token: string, employeeId: string): Promise<string> {
  const res = await request(API_BASE)
    .post(`/api/v1/employees/${employeeId}/documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      docType: 'passport',
      docNumber: `DOC-RBAC-${randomUUID().slice(0, 6)}`,
      expiryDate: addDays(new Date(), 30).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('E2 RBAC', () => {
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

  it('RBAC-E2-01: viewer can GET /employees -> 200', async () => {
    const res = await request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
  });

  it('RBAC-E2-02: viewer cannot POST /employees -> 403', async () => {
    const res = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ employeeCode: 'SHOULD-NOT-CREATE', firstName: 'X', lastName: 'Y' });
    expect(res.status).toBe(403);
  });

  it('RBAC-E2-03: viewer cannot PATCH /employees/:id -> 403', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ department: 'X', version: 1 });
    expect(res.status).toBe(403);
  });

  it('RBAC-E2-04: viewer cannot DELETE /employees/:id -> 403', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .delete(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('RBAC-E2-05: hr-staff can POST /employees -> 201', async () => {
    const res = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode: `EMP-RBAC-${randomUUID().slice(0, 8)}`, firstName: 'A', lastName: 'B' });
    expect(res.status).toBe(201);
  });

  it('RBAC-E2-06: hr-staff can PATCH /employees/:id -> 200', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'Finance', version: 1 });
    expect(res.status).toBe(200);
  });

  it('RBAC-E2-07: hr-staff cannot DELETE /employees/:id -> 403', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .delete(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(res.status).toBe(403);
  });

  it('RBAC-E2-08: hr-manager can DELETE /employees/:id -> 200', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .delete(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrManagerToken}`);
    expect(res.status).toBe(200);
  });

  it('RBAC-E2-09: hr-staff can PATCH /documents/:id with expiryStatus=EXCEPTION -> 200', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const documentId = await createDocument(hrStaffToken, employeeId);
    const res = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ expiryStatus: 'EXCEPTION', exceptionReason: 'Pending renewal appointment', version: 1 });
    expect(res.status).toBe(200);
  });

  it('RBAC-E2-10: viewer cannot PATCH /documents/:id -> 403', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const documentId = await createDocument(hrStaffToken, employeeId);
    const res = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ version: 1, docNumber: 'SHOULD-NOT-UPDATE' });
    expect(res.status).toBe(403);
  });
});
