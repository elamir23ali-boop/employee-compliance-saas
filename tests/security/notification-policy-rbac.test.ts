import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { ADMIN_TENANT_A_TOTP_SECRET, nextTotp } from '../support/totp';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('Notification policy RBAC', () => {
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

  it('NOTIF-RBAC-01: viewer cannot GET /notification-policy -> 403', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-policy')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('NOTIF-RBAC-02: hr-staff cannot GET /notification-policy -> 403', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-policy')
      .set('Authorization', `Bearer ${hrStaffToken}`);
    expect(res.status).toBe(403);
  });

  it('NOTIF-RBAC-03: hr-manager cannot PATCH /notification-policy -> 403', async () => {
    const res = await request(API_BASE)
      .patch('/api/v1/notification-policy')
      .set('Authorization', `Bearer ${hrManagerToken}`)
      .send({ enabled: false });
    expect(res.status).toBe(403);
  });

  it('NOTIF-RBAC-04: tenant-admin can GET /notification-policy -> 200', async () => {
    const res = await request(API_BASE)
      .get('/api/v1/notification-policy')
      .set('Authorization', `Bearer ${tenantAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('reminderDaysBefore');
  });

  it('NOTIF-RBAC-05: tenant-admin can PATCH /notification-policy -> 200', async () => {
    const res = await request(API_BASE)
      .patch('/api/v1/notification-policy')
      .set('Authorization', `Bearer ${tenantAdminToken}`)
      .send({ reminderDaysBefore: [90, 60, 30, 14, 7, 1], enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
  });
});

describe('Notification policy tenant isolation (RLS)', () => {
  let appClient: Client;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    appClient = new Client({ connectionString: url });
    await appClient.connect();
  });

  afterAll(async () => {
    await appClient.end();
  });

  it('NOTIF-RLS-01: tenant A cannot see tenant B notification policy row', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
    await appClient.query(
      `INSERT INTO tenant_notification_policies (tenant_id, email_from)
       VALUES ($1, 'tenant-b-only@example.test')
       ON CONFLICT (tenant_id) DO UPDATE SET email_from = EXCLUDED.email_from`,
      [TENANT_B],
    );
    await appClient.query('COMMIT');

    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query('SELECT * FROM tenant_notification_policies WHERE tenant_id = $1', [TENANT_B]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });
});
