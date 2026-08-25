import request from 'supertest';
import { describe, expect, it } from 'vitest';

const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

// A denylist, not an allowlist -- new fields are free to be added to either
// response later without this test needing to change, as long as none of
// these ever show up. This is what actually enforces "NO PII, NO DB
// version, NO internal state, NO env vars" (E5 Pillar 1) rather than just
// checking the two fields the spec calls out by name.
const FORBIDDEN_SUBSTRINGS = [
  'password',
  'postgresql://',
  'redis://',
  'DATABASE_URL',
  'REDIS_URL',
  'stack',
  'ECONNREFUSED',
  '@',
];

function assertNoForbiddenContent(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    expect(serialized.toLowerCase()).not.toContain(needle.toLowerCase());
  }
}

describe('Health endpoints (E5 Pillar 1)', () => {
  it('HEALTH-01: GET /health -> 200, correct shape, no auth required', async () => {
    const res = await request(API_BASE).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    expect(Object.keys(res.body).sort()).toEqual(['status', 'timestamp']);
    assertNoForbiddenContent(res.body);
  });

  it('HEALTH-02: GET /health/ready -> 200, status ready, db+redis ok, no auth required', async () => {
    const res = await request(API_BASE).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { db: 'ok', redis: 'ok' } });
    assertNoForbiddenContent(res.body);
  });

  it('HEALTH-03: neither health endpoint ever returns 401', async () => {
    const live = await request(API_BASE).get('/health');
    const ready = await request(API_BASE).get('/health/ready');
    expect(live.status).not.toBe(401);
    expect(ready.status).not.toBe(401);
  });
});
