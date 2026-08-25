import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { ADMIN_TENANT_A_TOTP_SECRET, nextTotp } from '../support/totp';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('Notification log RBAC', () => {
  let viewerToken: string;
  let hrStaffToken: string;
  let hrManagerToken: string;
  let tenantAdminToken: string;

  beforeAll(async () => {
    viewerToken = await getAccessToken('viewer_tenant_a@e0.local', 'TestPass123!');
    hrStaffToken = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    hrManagerToken = await getAccessToken('hr_manager_tenant_a@e0.local', 'TestPass123!');
    const totp = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
    tenantAdminToken = await getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', totp);
  });

  it('NLOG-RBAC-01: viewer cannot GET /notification-log/stats -> 403', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('NLOG-RBAC-02: hr-staff cannot GET /notification-log/stats -> 403', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(res.status).toBe(403);
  });

  it('NLOG-RBAC-03: hr-manager cannot GET /notification-log/stats -> 403', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .set('Authorization', `Bearer ${hrManagerToken}`);
    expect(res.status).toBe(403);
  });

  it('NLOG-RBAC-04: no bearer token -> 401', async () => {
    const res = await request(API_BASE).get('/api/v1/notification-log/stats');
    expect(res.status).toBe(401);
  });

  it('NLOG-RBAC-05: tenant-admin can GET /notification-log/stats -> 200', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .set('Authorization', `Bearer ${tenantAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('sentCount');
    expect(res.body.data).toHaveProperty('failedCount');
    expect(res.body.data).toHaveProperty('suppressedCount');
    expect(res.body.data).toHaveProperty('failureRate');
  });
});

describe('Notification log tenant isolation (RLS)', () => {
  let appClient: Client;
  let tenantAdminToken: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    appClient = new Client({ connectionString: url });
    await appClient.connect();
    const totp = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
    tenantAdminToken = await getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', totp);
  });

  afterAll(async () => {
    await appClient.end();
  });

  it('NLOG-RLS-01: tenant A cannot see tenant B notification_log rows', async () => {
    const baselineRes = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .query({ windowHours: 1 })
      .set('Authorization', `Bearer ${tenantAdminToken}`);
    expect(baselineRes.status).toBe(200);
    const baselineFailedCount = baselineRes.body.data.failedCount as number;

    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
    await appClient.query(
      `INSERT INTO notification_log (tenant_id, document_id, days_before_expiry, status)
       VALUES ($1, NULL, 30, 'FAILED')`,
      [TENANT_B],
    );
    await appClient.query('COMMIT');

    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query('SELECT * FROM notification_log WHERE tenant_id = $1', [TENANT_B]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);

    const statsRes = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .query({ windowHours: 1 })
      .set('Authorization', `Bearer ${tenantAdminToken}`);
    expect(statsRes.status).toBe(200);
    // tenant A's own stats must be unchanged by tenant B's just-seeded FAILED row.
    expect(statsRes.body.data.failedCount).toBe(baselineFailedCount);
  });
});
