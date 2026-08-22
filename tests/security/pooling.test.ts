import { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { ADMIN_TENANT_A_TOTP_SECRET, nextTotp } from '../support/totp';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const API_BASE = process.env.E0_API_BASE ?? 'http://localhost:3000';

interface Employee {
  tenantId: string; // Drizzle returns camelCase keys, unlike the response envelope's tenant_id
}

describe('Pooling tests', () => {
  it('POOL-01: SET LOCAL resets after transaction commit (same connection)', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
        const tx1 = await client.query('SELECT * FROM employees');
        await client.query('COMMIT');
        expect(tx1.rowCount).toBe(5);

        // Same connection, no set_config this time -> context must have reset on COMMIT.
        await client.query('BEGIN');
        const tx2 = await client.query('SELECT * FROM employees');
        await client.query('COMMIT');
        expect(tx2.rowCount).toBe(0);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  describe('HTTP-backed pooling tests', () => {
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
      const totp = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
      tokenA = await getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', totp);
      tokenB = await getAccessToken('viewer_tenant_b@e0.local', 'TestPass123!');
    });

    it('POOL-02: 20 concurrent requests, zero cross-tenant contamination', async () => {
      const reqsA = Array.from({ length: 10 }, () =>
        request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${tokenA}`),
      );
      const reqsB = Array.from({ length: 10 }, () =>
        request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${tokenB}`),
      );
      const results = await Promise.all([...reqsA, ...reqsB]);

      for (const res of results.slice(0, 10)) {
        expect(res.status).toBe(200);
        expect(res.body.tenant_id).toBe(TENANT_A);
        expect((res.body.data as Employee[]).every((e) => e.tenantId === TENANT_A)).toBe(true);
      }
      for (const res of results.slice(10)) {
        expect(res.status).toBe(200);
        expect(res.body.tenant_id).toBe(TENANT_B);
        expect((res.body.data as Employee[]).every((e) => e.tenantId === TENANT_B)).toBe(true);
      }
    });

    it('POOL-03: pool connection reuse leaves no stale context across tenants', async () => {
      const resA = await request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${tokenA}`);
      expect(resA.status).toBe(200);
      expect((resA.body.data as Employee[]).every((e) => e.tenantId === TENANT_A)).toBe(true);

      const resB = await request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${tokenB}`);
      expect(resB.status).toBe(200);
      expect((resB.body.data as Employee[]).some((e) => e.tenantId === TENANT_A)).toBe(false);
      expect((resB.body.data as Employee[]).every((e) => e.tenantId === TENANT_B)).toBe(true);
    });
  });
});
