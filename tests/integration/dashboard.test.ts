import { randomUUID } from 'node:crypto';
import { addDays } from 'date-fns';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

async function createEmployee(token: string): Promise<string> {
  const res = await request(API_BASE)
    .post('/api/v1/employees')
    .set('Authorization', `Bearer ${token}`)
    .send({ employeeCode: `EMP-DASH-${randomUUID().slice(0, 8)}`, firstName: 'Dash', lastName: 'Fixture' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function createDocument(token: string, employeeId: string, docType: string, daysUntilExpiry: number): Promise<string> {
  const res = await request(API_BASE)
    .post(`/api/v1/employees/${employeeId}/documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      docType,
      docNumber: `DOC-DASH-${randomUUID().slice(0, 6)}`,
      expiryDate: addDays(new Date(), daysUntilExpiry).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('Dashboard integration (E3 Phase 5)', () => {
  afterAll(async () => {
    await cleanupE2TestEmployees();
  });

  it('DASH-01: summary counts, document-stats breakdown, and expiring window all reflect seeded documents', async () => {
    const hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const viewerToken = await getAccessToken('viewer_tenant_a@e0.local', 'TestPass123!');
    const employeeId = await createEmployee(hrStaffToken);

    // 10 days out: within the default 90-day warning window -> EXPIRING_SOON.
    const soonDocId = await createDocument(hrStaffToken, employeeId, 'passport', 10);
    // 200 days out: beyond the default 90-day warning window -> VALID.
    const farDocId = await createDocument(hrStaffToken, employeeId, 'residence', 200);

    const summaryRes = await request(API_BASE)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.data.byStatus.EXPIRING_SOON).toBeGreaterThanOrEqual(1);
    expect(summaryRes.body.data.byStatus.VALID).toBeGreaterThanOrEqual(1);
    expect(summaryRes.body.data.totalDocuments).toBeGreaterThanOrEqual(2);
    // Every ExpiryStatus key is present even when some counts are 0.
    expect(Object.keys(summaryRes.body.data.byStatus).sort()).toEqual(
      ['BLOCKED', 'EXCEPTION', 'EXPIRED', 'EXPIRING_SOON', 'RENEWAL_IN_PROGRESS', 'VALID'].sort(),
    );

    const statsRes = await request(API_BASE)
      .get('/api/v1/dashboard/document-stats')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(statsRes.status).toBe(200);
    expect(
      statsRes.body.data.some(
        (row: { docType: string; expiryStatus: string; count: number }) =>
          row.docType === 'passport' && row.expiryStatus === 'EXPIRING_SOON' && row.count >= 1,
      ),
    ).toBe(true);
    expect(
      statsRes.body.data.some(
        (row: { docType: string; expiryStatus: string; count: number }) =>
          row.docType === 'residence' && row.expiryStatus === 'VALID' && row.count >= 1,
      ),
    ).toBe(true);

    const narrowRes = await request(API_BASE)
      .get('/api/v1/dashboard/expiring')
      .query({ withinDays: 15 })
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(narrowRes.status).toBe(200);
    const narrowIds = narrowRes.body.data.map((d: { id: string }) => d.id);
    expect(narrowIds).toContain(soonDocId);
    expect(narrowIds).not.toContain(farDocId);

    const wideRes = await request(API_BASE)
      .get('/api/v1/dashboard/expiring')
      .query({ withinDays: 250 })
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(wideRes.status).toBe(200);
    const wideIds = wideRes.body.data.map((d: { id: string }) => d.id);
    expect(wideIds).toContain(soonDocId);
    expect(wideIds).toContain(farDocId);
  });

  it('DASH-02: expiring rejects an out-of-range withinDays', async () => {
    const viewerToken = await getAccessToken('viewer_tenant_a@e0.local', 'TestPass123!');
    const res = await request(API_BASE)
      .get('/api/v1/dashboard/expiring')
      .query({ withinDays: 9999 })
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(400);
  });
});
