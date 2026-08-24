import { describe, expect, it } from 'vitest';
import { matchReminderThreshold } from '../../apps/worker/src/workers/reminder-policy';

describe('matchReminderThreshold', () => {
  const THRESHOLDS = [90, 60, 30, 14, 7, 1];

  it('REM-01: exact match on a threshold returns that threshold', () => {
    expect(matchReminderThreshold(30, THRESHOLDS)).toBe(30);
  });

  it('REM-02: exact match on the smallest threshold returns that threshold', () => {
    expect(matchReminderThreshold(1, THRESHOLDS)).toBe(1);
  });

  it('REM-03: exact match on the largest threshold returns that threshold', () => {
    expect(matchReminderThreshold(90, THRESHOLDS)).toBe(90);
  });

  it('REM-04: a day between two thresholds returns null (fires once, not every day in the window)', () => {
    expect(matchReminderThreshold(45, THRESHOLDS)).toBeNull();
    expect(matchReminderThreshold(29, THRESHOLDS)).toBeNull();
  });

  it('REM-05: a day beyond the widest threshold returns null', () => {
    expect(matchReminderThreshold(91, THRESHOLDS)).toBeNull();
  });

  it('REM-06: a negative days-until-expiry (already expired) returns null unless explicitly configured', () => {
    expect(matchReminderThreshold(-1, THRESHOLDS)).toBeNull();
  });

  it('REM-07: an empty threshold list never matches', () => {
    expect(matchReminderThreshold(30, [])).toBeNull();
  });

  it('REM-08: unordered threshold arrays still match correctly', () => {
    expect(matchReminderThreshold(7, [1, 90, 7, 30])).toBe(7);
  });
});
