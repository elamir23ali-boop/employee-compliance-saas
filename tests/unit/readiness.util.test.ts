import { describe, expect, it } from 'vitest';
import { computeReadiness } from '../../apps/api/src/health/readiness.util';

describe('computeReadiness', () => {
  it('READY-01: db ok + redis ok -> 200, status ready', () => {
    const result = computeReadiness({ db: 'ok', redis: 'ok' });
    expect(result.httpStatus).toBe(200);
    expect(result.body).toEqual({ status: 'ready', checks: { db: 'ok', redis: 'ok' } });
  });

  it('READY-02: db fail -> 503, status not_ready, checks.db is fail', () => {
    const result = computeReadiness({ db: 'fail', redis: 'ok' });
    expect(result.httpStatus).toBe(503);
    expect(result.body).toEqual({ status: 'not_ready', checks: { db: 'fail', redis: 'ok' } });
  });

  it('READY-03: redis fail -> 503, status not_ready, checks.redis is fail', () => {
    const result = computeReadiness({ db: 'ok', redis: 'fail' });
    expect(result.httpStatus).toBe(503);
    expect(result.body).toEqual({ status: 'not_ready', checks: { db: 'ok', redis: 'fail' } });
  });

  it('READY-04: both fail -> 503, status not_ready, both checks fail', () => {
    const result = computeReadiness({ db: 'fail', redis: 'fail' });
    expect(result.httpStatus).toBe(503);
    expect(result.body).toEqual({ status: 'not_ready', checks: { db: 'fail', redis: 'fail' } });
  });

  it('READY-05: response body never contains a field beyond status/checks', () => {
    const result = computeReadiness({ db: 'ok', redis: 'ok' });
    expect(Object.keys(result.body).sort()).toEqual(['checks', 'status']);
    expect(Object.keys(result.body.checks).sort()).toEqual(['db', 'redis']);
  });
});
