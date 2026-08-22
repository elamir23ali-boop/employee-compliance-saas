import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';

const API_BASE = process.env.E0_API_BASE ?? 'http://localhost:3000';

describe('RBAC tests', () => {
  it('AUTH-01: viewer cannot write', async () => {
    const token = await getAccessToken('viewer_tenant_b@e0.local', 'TestPass123!');
    const res = await request(API_BASE).post('/api/v1/test/write').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('AUTH-02: HR staff blocked from admin endpoint', async () => {
    const token = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const res = await request(API_BASE).get('/api/v1/test/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
