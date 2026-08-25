import { describe, expect, it } from 'vitest';
import {
  FAILURE_RATE_ALERT_THRESHOLD,
  MIN_ATTEMPTS_FOR_ALERT,
  shouldAlertOnFailureRate,
} from '../../apps/worker/src/workers/failure-alert-policy';

describe('shouldAlertOnFailureRate', () => {
  it('FAIL-01: below the minimum attempt sample size never alerts, even at 100% failure', () => {
    expect(MIN_ATTEMPTS_FOR_ALERT).toBeGreaterThan(1);
    expect(shouldAlertOnFailureRate({ sentCount: 0, failedCount: 1 })).toBe(false);
  });

  it('FAIL-02: exactly at the threshold with enough attempts alerts (boundary, >=)', () => {
    const failedCount = Math.ceil(MIN_ATTEMPTS_FOR_ALERT * FAILURE_RATE_ALERT_THRESHOLD);
    const sentCount = MIN_ATTEMPTS_FOR_ALERT - failedCount;
    expect(failedCount / MIN_ATTEMPTS_FOR_ALERT).toBeGreaterThanOrEqual(FAILURE_RATE_ALERT_THRESHOLD);
    expect(shouldAlertOnFailureRate({ sentCount, failedCount })).toBe(true);
  });

  it('FAIL-03: just below the threshold with enough attempts does not alert', () => {
    expect(shouldAlertOnFailureRate({ sentCount: 10, failedCount: 4 })).toBe(false);
  });

  it('FAIL-04: zero attempts never alerts (no divide-by-zero)', () => {
    expect(shouldAlertOnFailureRate({ sentCount: 0, failedCount: 0 })).toBe(false);
  });

  it('FAIL-05: high-volume, all-success never alerts', () => {
    expect(shouldAlertOnFailureRate({ sentCount: 1000, failedCount: 0 })).toBe(false);
  });

  it('FAIL-06: high-volume failure rate crossing the threshold alerts', () => {
    expect(shouldAlertOnFailureRate({ sentCount: 40, failedCount: 60 })).toBe(true);
  });
});
