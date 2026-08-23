import { Injectable } from '@nestjs/common';
import { differenceInCalendarDays } from 'date-fns';
import { ExpiryStatus, type expiryPolicies } from '@ecs/database';

export type ExpiryPolicyRow = typeof expiryPolicies.$inferSelect;

/**
 * Pure, side-effect-free expiry status calculation. Never touches the
 * database. Deterministic: same inputs always produce the same output.
 */
@Injectable()
export class ExpiryService {
  calculateStatus(
    expiryDate: Date | string | null,
    policy: Pick<
      ExpiryPolicyRow,
      'warningDays1' | 'warningDays2' | 'warningDays3' | 'criticalDays' | 'gracePeriodDays' | 'autoBlock'
    >,
    currentStatus: ExpiryStatus,
  ): ExpiryStatus {
    // Manual overrides are sticky -- the engine never auto-changes them.
    if (currentStatus === ExpiryStatus.RENEWAL_IN_PROGRESS || currentStatus === ExpiryStatus.EXCEPTION) {
      return currentStatus;
    }

    if (!expiryDate) {
      return ExpiryStatus.VALID;
    }

    const expiry = typeof expiryDate === 'string' ? new Date(expiryDate) : expiryDate;
    const today = new Date();
    const daysUntilExpiry = differenceInCalendarDays(expiry, today);

    if (daysUntilExpiry < 0) {
      if (policy.gracePeriodDays > 0 && daysUntilExpiry >= -policy.gracePeriodDays) {
        return ExpiryStatus.EXPIRING_SOON;
      }
      return policy.autoBlock ? ExpiryStatus.BLOCKED : ExpiryStatus.EXPIRED;
    }

    // Equivalent to the spec's four sequential threshold checks (critical,
    // warning3, warning2, warning1) -- each branch returns the same
    // EXPIRING_SOON result, so "within any threshold" collapses to "within
    // the largest configured threshold," regardless of whether a tenant's
    // policy happens to keep them in descending order.
    const widestWarningWindow = Math.max(
      policy.criticalDays,
      policy.warningDays3,
      policy.warningDays2,
      policy.warningDays1,
    );
    if (daysUntilExpiry <= widestWarningWindow) {
      return ExpiryStatus.EXPIRING_SOON;
    }

    return ExpiryStatus.VALID;
  }
}
