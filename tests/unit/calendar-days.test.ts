import { describe, expect, it } from 'vitest';
import * as apiCal from '../../apps/api/src/common/calendar-days';
import * as workerCal from '../../apps/worker/src/workers/calendar-days';

// apps/worker deliberately keeps its own copy of this helper (standalone
// process, ADR-016/ADR-017). This suite runs every case against BOTH so the
// two copies can never silently drift.
const impls = [
  ['api', apiCal],
  ['worker', workerCal],
] as const;

describe.each(impls)('calendarDaysUntil (%s copy)', (_name, cal) => {
  it('CAL-01: counts whole calendar days to a future date, UTC frame', () => {
    expect(cal.calendarDaysUntil('2026-10-01', new Date('2026-09-01T00:00:00Z'))).toBe(30);
  });

  it('CAL-02: is independent of the time-of-day of `now`', () => {
    for (const iso of ['2026-09-01T00:00:00Z', '2026-09-01T12:34:56Z', '2026-09-01T23:59:59Z']) {
      expect(cal.calendarDaysUntil('2026-10-01', new Date(iso))).toBe(30);
    }
  });

  it('CAL-03: the exact repro -- a UTC-evening instant that is already "tomorrow" in UTC+4', () => {
    // Local time on the dev box was 2026-09-02 00:17 (+04:00); a naive
    // local-frame calc returned 29 here and the scanner threshold never matched.
    expect(cal.calendarDaysUntil('2026-10-01', new Date('2026-09-01T20:17:00Z'))).toBe(30);
  });

  it('CAL-04: negative when the date is already past', () => {
    expect(cal.calendarDaysUntil('2026-08-30', new Date('2026-09-01T00:00:00Z'))).toBe(-2);
  });

  it('CAL-05: zero on the expiry date itself', () => {
    expect(cal.calendarDaysUntil('2026-09-01', new Date('2026-09-01T12:00:00Z'))).toBe(0);
  });

  it('CAL-06: accepts a Date object and reads it in the UTC frame', () => {
    expect(
      cal.calendarDaysUntil(new Date('2026-10-01T06:00:00Z'), new Date('2026-09-01T20:00:00Z')),
    ).toBe(30);
  });

  it('CAL-07: tolerates a full ISO datetime string', () => {
    expect(cal.calendarDaysUntil('2026-10-01T00:00:00.000Z', new Date('2026-09-01T00:00:00Z'))).toBe(30);
  });

  it('CAL-08: crosses a month boundary correctly', () => {
    expect(cal.calendarDaysUntil('2027-01-01', new Date('2026-12-25T00:00:00Z'))).toBe(7);
  });
});

describe.each(impls)('toUtcDateString (%s copy)', (_name, cal) => {
  it('CAL-09: formats the UTC calendar date of an instant', () => {
    expect(cal.toUtcDateString(new Date('2026-09-01T23:00:00Z'))).toBe('2026-09-01');
    expect(cal.toUtcDateString(new Date('2026-09-01T00:00:00Z'))).toBe('2026-09-01');
  });
});

describe('the two copies agree', () => {
  it('CAL-10: identical output across a matrix of inputs', () => {
    const now = new Date('2026-09-01T20:17:00Z');
    for (const days of [-400, -6, -1, 0, 1, 7, 14, 30, 60, 90, 91, 200, 365]) {
      const target = new Date(Date.UTC(2026, 8, 1) + days * 86_400_000).toISOString().slice(0, 10);
      expect(apiCal.calendarDaysUntil(target, now)).toBe(workerCal.calendarDaysUntil(target, now));
    }
  });
});
