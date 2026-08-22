import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, sleep } from 'k6';

// E0/E1 load test. Run once per scenario via -e SCENARIO=raw|employees|mixed
// (see /docs/e0/performance-results.md for how results are combined).
const API_BASE = __ENV.API_BASE || 'http://localhost:3000';
const KEYCLOAK_ISSUER = __ENV.KEYCLOAK_ISSUER || 'http://localhost:8080/realms/e0-test';
const CLIENT_ID = __ENV.KEYCLOAK_CLIENT_ID || 'e0-api';
const SCENARIO = __ENV.SCENARIO || 'raw';

const TENANT_A_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

// Keycloak does NOT base32-decode the OTP secret server-side -- it uses the
// secret string's raw UTF-8 bytes directly as the HMAC key. See
// /docs/architecture/decisions.md (ADR-004) and tests/support/totp.ts.
function totp(secret) {
  const key = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) key[i] = secret.charCodeAt(i);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hmacHex = crypto.hmac('sha1', key, counterBytes, 'hex');
  const hmacBytes = [];
  for (let i = 0; i < hmacHex.length; i += 2) {
    hmacBytes.push(parseInt(hmacHex.substr(i, 2), 16));
  }
  const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
  const binCode =
    ((hmacBytes[offset] & 0x7f) << 24) |
    ((hmacBytes[offset + 1] & 0xff) << 16) |
    ((hmacBytes[offset + 2] & 0xff) << 8) |
    (hmacBytes[offset + 3] & 0xff);
  const otp = binCode % 1000000;
  return otp.toString().padStart(6, '0');
}

function getToken(username, password, code) {
  const body = { grant_type: 'password', client_id: CLIENT_ID, username, password };
  if (code) body.totp = code;
  const res = http.post(`${KEYCLOAK_ISSUER}/protocol/openid-connect/token`, body);
  if (res.status !== 200) {
    throw new Error(`token request failed for ${username}: ${res.status} ${res.body}`);
  }
  return JSON.parse(res.body).access_token;
}

// Keycloak enforces single-use TOTP codes. Each separate `k6 run` invocation
// (e.g. running SCENARIO=employees right after SCENARIO=raw) has no way to
// know what code a previous run already consumed, so a collision within the
// same 30s window is possible -- retry with a fresh window on failure.
function getAdminTenantAToken() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return getToken('admin_tenant_a@e0.local', 'TestPass123!', totp(TENANT_A_TOTP_SECRET));
    } catch (err) {
      if (attempt === 2) throw err;
      sleep(31);
    }
  }
}

export function setup() {
  // Only fetch the token(s) the active scenario actually needs.
  const tokenA = SCENARIO === 'employees' || SCENARIO === 'mixed' ? getAdminTenantAToken() : null;
  const tokenB = SCENARIO === 'mixed' ? getToken('viewer_tenant_b@e0.local', 'TestPass123!') : null;
  return { tokenA, tokenB };
}

const scenarios = {};
if (SCENARIO === 'raw') {
  scenarios.raw = { executor: 'shared-iterations', vus: 1, iterations: 100, exec: 'rawQuery', maxDuration: '2m' };
} else if (SCENARIO === 'employees') {
  scenarios.employees = {
    executor: 'shared-iterations',
    vus: 1,
    iterations: 100,
    exec: 'employeesQuery',
    maxDuration: '2m',
  };
} else if (SCENARIO === 'mixed') {
  scenarios.mixed = { executor: 'constant-vus', vus: 20, duration: '30s', exec: 'mixedTenants' };
}

export const options = {
  scenarios,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function rawQuery() {
  const res = http.get(`${API_BASE}/api/v1/perf/raw-query`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function employeesQuery(data) {
  const res = http.get(`${API_BASE}/api/v1/employees`, {
    headers: { Authorization: `Bearer ${data.tokenA}` },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function mixedTenants(data) {
  const isA = __VU % 2 === 0;
  const token = isA ? data.tokenA : data.tokenB;
  const expectedTenant = isA ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const res = http.get(`${API_BASE}/api/v1/employees`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'no cross-tenant rows': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return body.tenant_id === expectedTenant && body.data.every((e) => e.tenantId === expectedTenant);
    },
  });
}

export function handleSummary(data) {
  const out = {};
  out[`/test-results/k6-summary-${SCENARIO}.json`] = JSON.stringify(data, null, 2);
  return out;
}
