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

describe('Audit trail integration (E2)', () => {
  let hrStaffToken: string;
  let migrationClient: Client;

  beforeAll(async () => {
    hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    migrationClient = await connectAsMigrationUser();
  });

  afterAll(async () => {
    await migrationClient.end();
    await cleanupE2TestEmployees();
  });

  it('AUDIT-INT-01: creating an employee writes a SUCCESS audit_events row with before=null/after=record', async () => {
    const employeeCode = `EMP-E2-${randomUUID().slice(0, 8)}`;
    const res = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode, firstName: 'Audit', lastName: 'Trail' });
    expect(res.status).toBe(201);
    const employeeId = res.body.data.id as string;

    const rows = await migrationClient.query(
      `SELECT action, entity_type, before_state, after_state, outcome, tenant_id
       FROM audit_events WHERE entity_id = $1 AND action = 'EMPLOYEE_CREATED'`,
      [employeeId],
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row.entity_type).toBe('employee');
    expect(row.outcome).toBe('SUCCESS');
    expect(row.before_state).toBeNull();
    expect(row.after_state.employeeCode).toBe(employeeCode);
    expect(row.after_state.fullName).toBe('Audit Trail');
  });

  it('AUDIT-INT-02: audit_events is never exposed through the employees/documents read APIs', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/employees?limit=1')
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row).not.toHaveProperty('auditEvents');
      expect(row).not.toHaveProperty('audit_events');
    }
    // And there is no dedicated audit route at all in E2.
    const auditRouteRes = await request(API_BASE).get('/api/v1/audit').set('Authorization', `Bearer ${hrStaffToken}`);
    expect(auditRouteRes.status).toBe(404);
  });

  it('AUDIT-INT-03: app_user cannot UPDATE or DELETE audit_events (DB-level enforcement, not just app logic)', async () => {
    const appUrl = process.env.DATABASE_URL;
    if (!appUrl) throw new Error('DATABASE_URL not set');
    const appClient = new Client({ connectionString: appUrl });
    await appClient.connect();
    try {
      await expect(appClient.query(`UPDATE audit_events SET outcome = 'FAILED'`)).rejects.toThrow();
      await expect(appClient.query(`DELETE FROM audit_events`)).rejects.toThrow();
    } finally {
      await appClient.end();
    }
  });

  it('AUDIT-INT-04: an EMPLOYEE_UPDATED audit row captures both before and after state', async () => {
    const employeeCode = `EMP-E2-${randomUUID().slice(0, 8)}`;
    const createRes = await request(API_BASE)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ employeeCode, firstName: 'Before', lastName: 'State', department: 'Operations' });
    const employeeId = createRes.body.data.id as string;

    await request(API_BASE)
      .patch(`/api/v1/employees/${employeeId}`)
      .set('Authorization', `Bearer ${hrStaffToken}`)
      .send({ department: 'Finance', version: 1 });

    const rows = await migrationClient.query(
      `SELECT before_state, after_state FROM audit_events WHERE entity_id = $1 AND action = 'EMPLOYEE_UPDATED'`,
      [employeeId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].before_state.department).toBe('Operations');
    expect(rows.rows[0].after_state.department).toBe('Finance');
  });
});
