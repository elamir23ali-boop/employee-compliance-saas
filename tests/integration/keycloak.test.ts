import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getAccessToken, requestToken } from '../support/keycloak-client';
import { setAccessTokenLifespan } from '../support/keycloak-admin';
import { ADMIN_TENANT_A_TOTP_SECRET, nextTotp } from '../support/totp';

const API_BASE = process.env.E0_API_BASE ?? 'http://localhost:3000';

describe('Keycloak auth tests', () => {
  it('KC-01: valid authentication works end-to-end', async () => {
    const code = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
    const token = await getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', code);
    const res = await request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
  });

  // Keycloak's token endpoint returns 400 {error: invalid_grant} for bad
  // credentials, per OAuth2 (RFC 6749 5.2) -- it never returns 401 here.
  // See /docs/architecture/decisions.md (ADR-007).
  it('KC-02: wrong password rejected by Keycloak', async () => {
    const result = await requestToken({ username: 'admin_tenant_a@e0.local', password: 'WrongPassword!' });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
  });

  it('KC-03: expired token rejected by API', async () => {
    await setAccessTokenLifespan(1);
    try {
      const code = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
      const token = await getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', code);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const res = await request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    } finally {
      await setAccessTokenLifespan(300);
    }
  });

  it('KC-04: corrupted JWT signature rejected', async () => {
    const code = await nextTotp(ADMIN_TENANT_A_TOTP_SECRET);
    const token = await getAccessToken('admin_tenant_a@e0.local', 'TestPass123!', code);
    const last3 = token.slice(-3);
    const replacement = last3 === 'xxx' ? 'yyy' : 'xxx';
    const corrupted = token.slice(0, -3) + replacement;

    const res = await request(API_BASE).get('/api/v1/employees').set('Authorization', `Bearer ${corrupted}`);
    expect(res.status).toBe(401);
  });

  it('KC-05: disabled user cannot get a token', async () => {
    const result = await requestToken({ username: 'disabled_user@e0.local', password: 'TestPass123!' });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
  });
});
