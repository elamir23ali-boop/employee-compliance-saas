/**
 * Pure, side-effect-free failure-rate alert gate: a tenant's notification
 * delivery is flagged only when it has accumulated enough recent attempts to
 * be a meaningful sample (MIN_ATTEMPTS_FOR_ALERT) AND the failed share of
 * those attempts meets FAILURE_RATE_ALERT_THRESHOLD. Both are hardcoded this
 * phase (E4 Pillar 4) -- no tenant_notification_policies column exists for
 * this yet, an explicit, documented gap (see docs/architecture/decisions.md,
 * ADR-031), same treatment ADR-026/030 gave other not-yet-configurable
 * values. SUPPRESSED outcomes are deliberately excluded from the attempt
 * count -- they are a business decision (no email on file / document gone,
 * ADR-026 decision #2), not a delivery failure, and would dilute a real SMTP
 * outage signal.
 */
export const FAILURE_RATE_ALERT_THRESHOLD = 0.5;
export const MIN_ATTEMPTS_FOR_ALERT = 5;

export interface FailureCounts {
  sentCount: number;
  failedCount: number;
}

export function shouldAlertOnFailureRate(counts: FailureCounts): boolean {
  const totalAttempts = counts.sentCount + counts.failedCount;
  if (totalAttempts < MIN_ATTEMPTS_FOR_ALERT) return false;
  return counts.failedCount / totalAttempts >= FAILURE_RATE_ALERT_THRESHOLD;
}
