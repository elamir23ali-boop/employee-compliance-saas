/**
 * Calendar-date arithmetic normalised to UTC.
 *
 * `documents.expiry_date` is a Postgres DATE and the create/update DTOs carry a
 * `YYYY-MM-DD` string (`z.string().date()`): both are calendar dates with no
 * time and no timezone. The previous approach --
 * `differenceInCalendarDays(new Date(expiryString), new Date())` -- mixed two
 * frames: `new Date('2026-10-01')` parses as UTC midnight, but
 * `differenceInCalendarDays` then reduces both operands to *local* midnight.
 * On any host not running in UTC that shifts the result by a day. Confirmed on
 * a UTC+4 dev box: a document exactly 30 calendar days out was computed as 29,
 * so the reminder scanner's exact-day threshold match (ADR-026) silently never
 * fired. The production containers and CI both run UTC, so normalising every
 * date-only comparison to a UTC frame makes dev, CI, and prod agree. See
 * ADR-033.
 */

function utcMidnightMillis(value: string | Date): number {
  if (typeof value === 'string') {
    // Tolerates a bare 'YYYY-MM-DD' or a full ISO datetime string.
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
