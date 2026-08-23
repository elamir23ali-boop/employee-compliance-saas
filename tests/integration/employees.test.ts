import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

async function connectAsMigrationUser(): Promise<Client> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

describe('Employees integration (E2)', () => {
  let hrStaffToken: string;
  let hrManagerToken: string;
  let migrationClient: Client;

  beforeAll(async () => {
    hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    hrManagerToken = await getAccessToken('hr_manager_tenant_a@e0.local', 'TestPass123!');
    migrationClient = await connectAsMigrationUser();
  });

  afterAll(async () => {
    await migrationClient.end();
    await cleanupE2TestEmployees();
  });

  it('EMP-INT-01: full lifecycle -- create, audit event, update, wrong-version 409, archive, list exclusion', async () => {
    const employeeCode = `EMP-E2-${randomUUID().slice(0, 8)}`;

    const createRes = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode, firstName: 'E2First', lastName: 'E2Last', department: 'Operations' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.employeeCode).toBe(employeeCode);
    expect(createRes.body.data.version).toBe(1);
    expect(createRes.body.requestId).toBeTruthy();
    const employeeId = createRes.body.data.id as string;

    // Audit event exists (read directly via migration_user -- no audit read API in E2).
    const auditRows = await migrationClient.query(
      `SELECT action, outcome, entity_id FROM audit_events WHERE entity_id = $1 AND action = 'EMPLOYEE_CREATED'`,
      [employeeId],
    );
    expect(auditRows.rowCount).toBe(1);
    expect(auditRows.rows[0].outcome).toBe('SUCCESS');

    // Update with correct version -> success, version increments.
    const updateRes = await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'Finance', version: 1 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.department).toBe('Finance');
    expect(updateRes.body.data.version).toBe(2);

    // Update with stale version -> 409.
    const staleRes = await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'HR', version: 1 });
    expect(staleRes.status).toBe(409);
    expect(staleRes.body.detail).toBe('version_mismatch');

    const updateAuditRows = await migrationClient.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'EMPLOYEE_UPDATED'`,
      [employeeId],
    );
    expect(updateAuditRows.rowCount).toBe(1);

    // Archive (soft delete) -- requires hr-manager.
    const archiveRes = await request(API_BASE)
      .delete(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrManagerToken}`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.archivedAt).toBeTruthy();

    const archiveAuditRows = await migrationClient.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'EMPLOYEE_ARCHIVED'`,
      [employeeId],
    );
    expect(archiveAuditRows.rowCount).toBe(1);

    // Archived employee excluded from list and 404 on direct fetch.
    const getRes = await request(API_BASE)
      .get(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(getRes.status).toBe(404);

    const listRes = await request(API_BASE)
      .get(`/api/v1/employees?limit=100`)
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((e: { id: string }) => e.id === employeeId)).toBe(false);
  });

  it('EMP-INT-02: duplicate employee_code within a tenant -> 409', async () => {
    const employeeCode = `EMP-E2-${randomUUID().slice(0, 8)}`;
    const first = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode, firstName: 'A', lastName: 'B' });
    expect(first.status).toBe(201);

    const second = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode, firstName: 'C', lastName: 'D' });
    expect(second.status).toBe(409);
    expect(second.body.detail).toBe('duplicate_code');
  });

  it('EMP-INT-03: full-text search finds an employee by first name', async () => {
    const employeeCode = `EMP-E2-${randomUUID().slice(0, 8)}`;
    const uniqueFirstName = `Searchable${randomUUID().slice(0, 8)}`;
    const createRes = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode, firstName: uniqueFirstName, lastName: 'Zzz' });
    expect(createRes.status).toBe(201);

    const searchRes = await request(API_BASE)
      .get(`/api/v1/employees?q=${uniqueFirstName}`)
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data.some((e: { id: string }) => e.id === createRes.body.data.id)).toBe(true);
  });

  it('EMP-INT-04: pagination returns the requested page/limit shape', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/employees?page=1&limit=2')
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(typeof res.body.total).toBe('number');
  });
});
