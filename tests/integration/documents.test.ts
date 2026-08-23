import { randomUUID } from 'node:crypto';
import { addDays } from 'date-fns';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

function isoDate(daysFromNow: number): string {
  return addDays(new Date(), daysFromNow).toISOString().slice(0, 10);
}

async function createEmployee(token: string): Promise<string> {
  const res = await request(API_BASE)
    .post('/api/v1/employees')
    .set('Authorization', `Bearer ${token}`)
    .send({ employeeCode: `EMP-E2-${randomUUID().slice(0, 8)}`, firstName: 'Doc', lastName: 'Owner' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('Documents integration (E2)', () => {
  let hrStaffToken: string;
  let hrManagerToken: string;

  beforeAll(async () => {
    hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    hrManagerToken = await getAccessToken('hr_manager_tenant_a@e0.local', 'TestPass123!');
  });

  afterAll(async () => {
    await cleanupE2TestEmployees();
  });

  it('DOC-INT-01: create -> expiry_status is calculated by the Expiry Engine (far future -> VALID)', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .post(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ docType: 'passport', docNumber: `DOC-E2-${randomUUID().slice(0, 6)}`, expiryDate: isoDate(365) });
    expect(res.status).toBe(201);
    expect(res.body.data.expiryStatus).toBe('VALID');
    expect(res.body.data.version).toBe(1);
  });

  it('DOC-INT-02: create with a near expiry date -> EXPIRING_SOON', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const res = await request(API_BASE)
      .post(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ docType: 'residence', docNumber: `DOC-E2-${randomUUID().slice(0, 6)}`, expiryDate: isoDate(10) });
    expect(res.status).toBe(201);
    expect(res.body.data.expiryStatus).toBe('EXPIRING_SOON');
  });

  it('DOC-INT-03: updating expiryDate recalculates expiry_status', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const createRes = await request(API_BASE)
      .post(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ docType: 'badge', docNumber: `DOC-E2-${randomUUID().slice(0, 6)}`, expiryDate: isoDate(365) });
    expect(createRes.body.data.expiryStatus).toBe('VALID');
    const documentId = createRes.body.data.id as string;

    const updateRes = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ expiryDate: isoDate(5), version: 1 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.expiryStatus).toBe('EXPIRING_SOON');
    expect(updateRes.body.data.version).toBe(2);
  });

  it('DOC-INT-04: manual override to RENEWAL_IN_PROGRESS is preserved across a later expiryDate-only update', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const createRes = await request(API_BASE)
      .post(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ docType: 'passport', docNumber: `DOC-E2-${randomUUID().slice(0, 6)}`, expiryDate: isoDate(5) });
    const documentId = createRes.body.data.id as string;

    const overrideRes = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ expiryStatus: 'RENEWAL_IN_PROGRESS', version: 1 });
    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.data.expiryStatus).toBe('RENEWAL_IN_PROGRESS');

    // A subsequent update that only touches expiryDate must not silently
    // clobber the manual override -- the Expiry Engine treats
    // RENEWAL_IN_PROGRESS as sticky.
    const followUpRes = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ expiryDate: isoDate(400), version: 2 });
    expect(followUpRes.status).toBe(200);
    expect(followUpRes.body.data.expiryStatus).toBe('RENEWAL_IN_PROGRESS');
  });

  it('DOC-INT-05: EXCEPTION override requires exceptionReason -> 400 without it, 200 with it', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const createRes = await request(API_BASE)
      .post(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ docType: 'residence', docNumber: `DOC-E2-${randomUUID().slice(0, 6)}`, expiryDate: isoDate(5) });
    const documentId = createRes.body.data.id as string;

    const missingReasonRes = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ expiryStatus: 'EXCEPTION', version: 1 });
    expect(missingReasonRes.status).toBe(400);

    const withReasonRes = await request(API_BASE)
      .patch(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ expiryStatus: 'EXCEPTION', exceptionReason: 'Awaiting embassy appointment', version: 1 });
    expect(withReasonRes.status).toBe(200);
    expect(withReasonRes.body.data.expiryStatus).toBe('EXCEPTION');
    expect(withReasonRes.body.data.exceptionReason).toBe('Awaiting embassy appointment');
  });

  it('DOC-INT-06: soft delete removes a document from the active employee document list', async () => {
    const employeeId = await createEmployee(hrStaffToken);
    const createRes = await request(API_BASE)
      .post(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ docType: 'badge', docNumber: `DOC-E2-${randomUUID().slice(0, 6)}`, expiryDate: isoDate(365) });
    const documentId = createRes.body.data.id as string;

    const archiveRes = await request(API_BASE)
      .delete(`/api/v1/documents/${documentId}`)
      .set('Authorization', `Bearer ${hrManagerToken}`);
    expect(archiveRes.status).toBe(200);

    const listRes = await request(API_BASE)
      .get(`/api/v1/employees/${employeeId}/documents`)
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((d: { id: string }) => d.id === documentId)).toBe(false);
  });
});
