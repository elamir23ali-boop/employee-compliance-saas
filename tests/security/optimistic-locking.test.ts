import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

describe('Optimistic locking (E2)', () => {
  let hrStaffToken: string;

  beforeAll(async () => {
    hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
  });

  afterAll(async () => {
    await cleanupE2TestEmployees();
  });

  it('LOCK-01: two concurrent PATCH requests with the same version -- exactly one succeeds, the other gets 409', async () => {
    const createRes = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode: `EMP-LOCK-${randomUUID().slice(0, 8)}`, firstName: 'Lock', lastName: 'Test' });
    expect(createRes.status).toBe(201);
    const employeeId = createRes.body.data.id as string;

    const [resA, resB] = await Promise.all([
      request(API_BASE)
        .patch(`/api/v1/employees/${employeeId}`)
        .set('Authorization', `Bearer ${hrStaffToken}`)
        .send({ department: 'Finance', version: 1 }),
      request(API_BASE)
        .patch(`/api/v1/employees/${employeeId}`)
        .set('Authorization', `Bearer ${hrStaffToken}`)
        .send({ department: 'Operations', version: 1 }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = resA.status === 200 ? resA : resB;
    expect(winner.body.data.version).toBe(2);
  });

  it('LOCK-02: a successful update increments version in the response', async () => {
    const createRes = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode: `EMP-LOCK-${randomUUID().slice(0, 8)}`, firstName: 'Lock', lastName: 'Two' });
    const employeeId = createRes.body.data.id as string;
    expect(createRes.body.data.version).toBe(1);

    const updateRes = await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'Finance', version: 1 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.version).toBe(2);
  });

  it('LOCK-03: a stale version is always rejected with 409, even after the record has moved on', async () => {
    const createRes = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode: `EMP-LOCK-${randomUUID().slice(0, 8)}`, firstName: 'Lock', lastName: 'Three' });
    const employeeId = createRes.body.data.id as string;

    await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'Finance', version: 1 });
    await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'Operations', version: 2 });

    // version is now 3 -- retrying with the original stale version=1 must still 409.
    const staleRes = await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'HR', version: 1 });
    expect(staleRes.status).toBe(409);
    expect(staleRes.body.detail).toBe('version_mismatch');
  });
});
