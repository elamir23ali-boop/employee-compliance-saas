export type CheckStatus = 'ok' | 'fail';

export interface ReadinessChecks {
  db: CheckStatus;
  redis: CheckStatus;
}

export interface ReadinessResult {
  httpStatus: 200 | 503;
  body: { status: 'ready' | 'not_ready'; checks: ReadinessChecks };
}

/**
 * Pure, side-effect-free aggregation of two independent check results into
 * the /health/ready response shape -- deliberately separated from the actual
 * DB/Redis pings (HealthService) so the ready/not_ready decision itself is
 * unit-testable without a live stack, the same pattern this repo already
 * uses for other decision cores (matchReminderThreshold, ADR-027;
 * shouldAlertOnFailureRate, ADR-031).
 */
export function computeReadiness(checks: ReadinessChecks): ReadinessResult {
  const ready = checks.db === 'ok' && checks.redis === 'ok';
  return {
    httpStatus: ready ? 200 : 503,
    body: { status: ready ? 'ready' : 'not_ready', checks },
  };
}
