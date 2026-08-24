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
    .send({ employeeCode: `EMP-DASH-${randomUUID().slice(0, 8)}`, firstName: 'Dash', lastName: 'Rbac' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function createDocument(token: string, employeeId: string): Promise<string> {
  const res = await request(API_BASE)
    .post(`/api/v1/employees/${employeeId}/documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      docType: 'passport',
      docNumber: `DOC-DASH-${randomUUID().slice(0, 6)}`,
      expiryDate: addDays(new Date(), 30).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('Dashboard RBAC and tenant isolation', () => {
  let viewerTokenA: string;
  let viewerTokenB: string;

  beforeAll(async () => {
    viewerTokenA = await getAccessToken('viewer_tenant_a@e0.local', 'TestPass123!');
    viewerTokenB = await getAccessToken('viewer_tenant_b@e0.local', 'TestPass123!');
  });

  afterAll(async () => {
    await cleanupE2TestEmployees();
  });

  it('DASH-RBAC-01: viewer can GET all three dashboard routes -> 200', async () => {
    const summaryRes = await request(API_BASE)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${viewerTokenA}`);
    expect(summaryRes.status).toBe(200);

    const statsRes = await request(API_BASE)
      .get('/api/v1/dashboard/document-stats')
      .set('Authorization', `Bearer ${viewerTokenA}`);
    expect(statsRes.status).toBe(200);

    const expiringRes = await request(API_BASE)
      .get('/api/v1/dashboard/expiring')
      .set('Authorization', `Bearer ${viewerTokenA}`);
    expect(expiringRes.status).toBe(200);
  });

  it('DASH-RBAC-02: an unauthenticated request is rejected on all three routes', async () => {
    for (const path of ['summary', 'document-stats', 'expiring']) {
      const res = await request(API_BASE).get(`/api/v1/dashboard/${path}`);
      expect(res.status).toBe(401);
    }
  });

  it('DASH-RBAC-03: tenant B never sees a document created in tenant A', async () => {
    const hrStaffTokenA = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const employeeId = await createEmployee(hrStaffTokenA);
    const documentId = await createDocument(hrStaffTokenA, employeeId);

    const tenantBExpiring = await request(API_BASE)
      .get('/api/v1/dashboard/expiring')
      .query({ withinDays: 365 })
      .set('Authorization', `Bearer ${viewerTokenB}`);
    expect(tenantBExpiring.status).toBe(200);
    const idsInB = tenantBExpiring.body.data.map((d: { id: string }) => d.id);
    expect(idsInB).not.toContain(documentId);
  });
});
