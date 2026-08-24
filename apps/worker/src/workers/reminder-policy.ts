/**
 * Pure, side-effect-free reminder-cadence rule: a document is due for a
 * reminder exactly when daysUntilExpiry matches one of the tenant's
 * configured thresholds -- not "any day within the widest window" (unlike
 * the Expiry Engine's EXPIRING_SOON check). This fires each threshold
 * exactly once per document instead of every day of the window, and lets
 * notification_log's per-(documentId, daysBeforeExpiry) dedup work.
 */
export function matchReminderThreshold(daysUntilExpiry: number, reminderDaysBefore: number[]): number | null {
  const match = reminderDaysBefore.find((threshold) => threshold === daysUntilExpiry);
  return match ?? null;
}
