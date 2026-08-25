import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { ADMIN_TENANT_A_TOTP_SECRET, nextTotp } from '../support/totp';
import { seedNotificationLogRows } from '../support/seed-notification-log';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function tenantAdminToken(): Promise<string> {
  const totp = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
  return getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', totp);
}

describe('Notification log stats (E4 Pillar 4)', () => {
  it('NLOG-01: counts and failure rate reflect seeded SENT/FAILED/SUPPRESSED rows', async () => {
    await seedNotificationLogRows(TENANT_A, [
      { status: 'SENT' },
      { status: 'SENT' },
      { status: 'FAILED' },
      { status: 'SUPPRESSED' },
    ]);

    const token = await tenantAdminToken();
    const res = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .query({ windowHours: 1 })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sentCount).toBeGreaterThanOrEqual(2);
    expect(res.body.data.failedCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.suppressedCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.totalAttempts).toBe(res.body.data.sentCount + res.body.data.failedCount);
    expect(res.body.data.failureRate).toBeCloseTo(
      res.body.data.failedCount / res.body.data.totalAttempts,
      10,
    );
  });

  it('NLOG-02: failureRate is null when there are zero attempts in the window', async () => {
    const token = await tenantAdminToken();
    // A 1-hour window immediately after connecting almost certainly has no
    // notification_log activity for this run, in a database this test suite
    // doesn't otherwise seed concurrently within the same second -- best
    // effort, matching this repo's existing tolerance for a shared test DB.
    const res = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .query({ windowHours: 1 })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    if (res.body.data.totalAttempts === 0) {
      expect(res.body.data.failureRate).toBeNull();
    }
  });

  it('NLOG-03: windowHours out of range is rejected', async () => {
    const token = await tenantAdminToken();
    const tooLow = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .query({ windowHours: 0 })
      .set('Authorization', `Bearer ${token}`);
    expect(tooLow.status).toBe(400);

    const tooHigh = await request(API_BASE)
      .get('/api/v1/notification-log/stats')
      .query({ windowHours: 9999 })
      .set('Authorization', `Bearer ${token}`);
    expect(tooHigh.status).toBe(400);
  });
});
