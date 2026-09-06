// Shared workload definition for the E6 load/stress k6 scenarios.
//
// Pure ESM, no k6 xk6 extensions -- everything here runs on stock `k6 run`.
// The API contract mirrored below is whatever apps/api actually serves today
// (see apps/api/src/**/*.controller.ts); keep it in sync by hand.

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const KC_ISSUER =
  __ENV.KEYCLOAK_ISSUER || 'http://localhost:8080/realms/e0-test';
export const KC_CLIENT_ID = __ENV.KEYCLOAK_CLIENT_ID || 'e0-api';
export const SEED_KC_PASSWORD = __ENV.SEED_KC_PASSWORD || 'SeedPass123!';

// Seed tenants (mirrors tools/seed/config.ts). `weight` drives how often a VU
// iteration targets that tenant -- proportional to employee count, so the
// largest tenant (Alpha, 50k) takes the brunt exactly as in production.
export const SEED_TENANTS = [
  { slug: 'seed-alpha-corp', name: 'Alpha Corp', weight: 50 },
  { slug: 'seed-beta-llc', name: 'Beta LLC', weight: 25 },
  { slug: 'seed-gamma-inc', name: 'Gamma Inc', weight: 15 },
  { slug: 'seed-delta-co', name: 'Delta Co', weight: 7 },
  { slug: 'seed-epsilon-ltd', name: 'Epsilon Ltd', weight: 3 },
];

// Free-text search terms that actually hit seeded rows: @faker-js/faker
// commerce.department() + person.jobType() vocab lands in the employees
// full-text index (employee_code + first/last name + department).
export const SEARCH_TERMS = [
  'Books', 'Movies', 'Electronics', 'Home', 'Garden', 'Tools', 'Grocery',
  'Health', 'Beauty', 'Toys', 'Kids', 'Clothing', 'Shoes', 'Computers',
  'Games', 'Automotive', 'Industrial', 'Outdoors', 'Sports', 'Music',
  'Coordinator', 'Manager', 'Analyst', 'Officer', 'Administrator', 'Agent',
  'Designer', 'Developer', 'Engineer', 'Specialist', 'Consultant', 'Director',
];

// Per-endpoint latency trends so the summary breaks down by call, not just
// one global http_req_duration.
export const trends = {
  health: new Trend('lat_health', true),
  emp_list: new Trend('lat_emp_list', true),
  emp_search: new Trend('lat_emp_search', true),
  dash_summary: new Trend('lat_dash_summary', true),
  dash_doc_stats: new Trend('lat_dash_doc_stats', true),
  dash_expiring: new Trend('lat_dash_expiring', true),
};

/** ROPC token grant for one seed tenant's hr-manager user. Run once in setup(). */
export function fetchTokens() {
  const out = {};
  for (const t of SEED_TENANTS) {
    const res = http.post(
      `${KC_ISSUER}/protocol/openid-connect/token`,
      {
        grant_type: 'password',
        client_id: KC_CLIENT_ID,
        username: `seed-e6-${t.slug}@e6.local`,
        password: SEED_KC_PASSWORD,
      },
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, tags: { name: 'kc_token' } },
    );
    if (res.status !== 200) {
      throw new Error(`token grant failed for ${t.slug}: ${res.status} ${res.body}`);
    }
    out[t.slug] = JSON.parse(res.body).access_token;
  }
  return out;
}

/** Weighted pick of a seed tenant for this iteration. */
export function pickTenant() {
  const total = SEED_TENANTS.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of SEED_TENANTS) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return SEED_TENANTS[0];
}

function authGet(path, token, name) {
  return http.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name },
  });
}

/**
 * One weighted read-mix iteration against `tenant`, using the token map from
 * setup(). Mix roughly models a compliance dashboard session: mostly
 * dashboard widgets + the odd employee search / list page, plus a cheap
 * unauthenticated health poll.
 */
export function readMixIteration(tokens) {
  const tenant = pickTenant();
  const token = tokens[tenant.slug];
  const roll = Math.random();

  let res;
  let key;
  if (roll < 0.28) {
    key = 'dash_summary';
    res = authGet('/api/v1/dashboard/summary', token, key);
  } else if (roll < 0.5) {
    key = 'dash_doc_stats';
    res = authGet('/api/v1/dashboard/document-stats', token, key);
  } else if (roll < 0.7) {
    key = 'dash_expiring';
    const within = [7, 30, 60, 90][Math.floor(Math.random() * 4)];
    res = authGet(`/api/v1/dashboard/expiring?withinDays=${within}&limit=20`, token, key);
  } else if (roll < 0.85) {
    key = 'emp_search';
    const q = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
    res = authGet(`/api/v1/employees?q=${encodeURIComponent(q)}&limit=20`, token, key);
  } else if (roll < 0.97) {
    key = 'emp_list';
    const page = 1 + Math.floor(Math.random() * 25);
    res = authGet(`/api/v1/employees?page=${page}&limit=20`, token, key);
  } else {
    key = 'health';
    res = http.get(`${BASE_URL}/health/ready`, { tags: { name: key } });
  }

  trends[key].add(res.timings.duration);
  check(res, {
    'status 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 0,
  });
  return res;
}
