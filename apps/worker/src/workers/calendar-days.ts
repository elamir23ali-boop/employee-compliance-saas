/**
 * Calendar-date arithmetic normalised to UTC.
 *
 * Mirrors `apps/api/src/common/calendar-days.ts` -- duplicated here (not
 * imported across apps) for the same reason `DEFAULT_REMINDER_DAYS_BEFORE` in
 * reminder-scanner.worker.ts is: `apps/worker` is a standalone process with no
 * dependency on `apps/api` (ADR-016/ADR-017). Keep the two copies identical.
 *
 * Why UTC: `documents.expiry_date` is a Postgres DATE (a calendar date, no
 * time, no timezone). The previous
 * `differenceInCalendarDays(new Date(expiryString), new Date())` parsed the
 * string as UTC midnight but then reduced both operands to *local* midnight,
 * shifting the result by a day on any host not running in UTC -- on a UTC+4
 * dev box a document exactly 30 days out computed as 29, so the exact-day
 * threshold match (ADR-026) never fired. CI and the production containers run
 * UTC; normalising to a UTC frame makes dev, CI, and prod agree. See ADR-033.
 */

function utcMidnightMillis(value: string | Date): number {
  if (typeof value === 'string') {
    const s = value.slice(0, 10);
    return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  }
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** The UTC calendar date of an instant, as `YYYY-MM-DD`. */
export function toUtcDateString(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `now`'s UTC date until `expiryDate`'s UTC date.
 * Negative when `expiryDate` is already past. Timezone-independent: with an
 * explicit `now` it never reads the host clock or locale.
 */
export function calendarDaysUntil(expiryDate: string | Date, now: Date = new Date()): number {
  const diffMs = utcMidnightMillis(expiryDate) - utcMidnightMillis(now);
  return Math.round(diffMs / 86_400_000);
}
