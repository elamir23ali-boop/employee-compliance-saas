import { addDays } from 'date-fns';
import { describe, expect, it } from 'vitest';
import { ExpiryService } from '../../apps/api/src/expiry/expiry.service';
import { ExpiryStatus } from '@ecs/database';

const DEFAULT_POLICY = {
  warningDays1: 90,
  warningDays2: 60,
  warningDays3: 30,
  criticalDays: 14,
  gracePeriodDays: 0,
  autoBlock: false,
};

describe('ExpiryService.calculateStatus', () => {
  const engine = new ExpiryService();

  it('EXP-01: null expiry date -> VALID', () => {
    expect(engine.calculateStatus(null, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.VALID);
  });

  it('EXP-02: far future date, beyond all warning windows -> VALID', () => {
    const expiry = addDays(new Date(), 100);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.VALID);
  });

  it('EXP-03: 91 days out (just beyond warningDays1) -> VALID', () => {
    const expiry = addDays(new Date(), 91);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.VALID);
  });

  it('EXP-04: exactly warningDays1 (90 days) -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), 90);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-05: exactly warningDays2 (60 days) -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), 60);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-06: exactly warningDays3 (30 days) -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), 30);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-07: exactly criticalDays (14 days) -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), 14);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-08: 1 day out -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), 1);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-09: expires today (0 days) -> EXPIRING_SOON', () => {
    const expiry = new Date();
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-10: 1 day past, no grace period, autoBlock=false -> EXPIRED', () => {
    const expiry = addDays(new Date(), -1);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRED);
  });

  it('EXP-11: 1 day past, within a 5-day grace period -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), -1);
    const policy = { ...DEFAULT_POLICY, gracePeriodDays: 5 };
    expect(engine.calculateStatus(expiry, policy, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-12: exactly at the grace period boundary (-gracePeriodDays) -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), -5);
    const policy = { ...DEFAULT_POLICY, gracePeriodDays: 5 };
    expect(engine.calculateStatus(expiry, policy, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-13: one day past the grace period boundary -> EXPIRED', () => {
    const expiry = addDays(new Date(), -6);
    const policy = { ...DEFAULT_POLICY, gracePeriodDays: 5 };
    expect(engine.calculateStatus(expiry, policy, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRED);
  });

  it('EXP-14: past date, autoBlock=true, no grace period -> BLOCKED', () => {
    const expiry = addDays(new Date(), -10);
    const policy = { ...DEFAULT_POLICY, autoBlock: true };
    expect(engine.calculateStatus(expiry, policy, ExpiryStatus.VALID)).toBe(ExpiryStatus.BLOCKED);
  });

  it('EXP-15: past date within an active grace period takes priority over autoBlock -> EXPIRING_SOON', () => {
    const expiry = addDays(new Date(), -2);
    const policy = { ...DEFAULT_POLICY, gracePeriodDays: 5, autoBlock: true };
    expect(engine.calculateStatus(expiry, policy, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });

  it('EXP-16: currentStatus RENEWAL_IN_PROGRESS is sticky regardless of a far-past date', () => {
    const expiry = addDays(new Date(), -400);
    const policy = { ...DEFAULT_POLICY, autoBlock: true };
    expect(engine.calculateStatus(expiry, policy, ExpiryStatus.RENEWAL_IN_PROGRESS)).toBe(
      ExpiryStatus.RENEWAL_IN_PROGRESS,
    );
  });

  it('EXP-17: currentStatus EXCEPTION is sticky regardless of a far-future date', () => {
    const expiry = addDays(new Date(), 400);
    expect(engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.EXCEPTION)).toBe(ExpiryStatus.EXCEPTION);
  });

  it('EXP-18: currentStatus EXCEPTION is sticky even with a null expiry date', () => {
    expect(engine.calculateStatus(null, DEFAULT_POLICY, ExpiryStatus.EXCEPTION)).toBe(ExpiryStatus.EXCEPTION);
  });

  it('EXP-19: deterministic -- same inputs always produce the same output', () => {
    const expiry = addDays(new Date(), 45);
    const first = engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID);
    const second = engine.calculateStatus(expiry, DEFAULT_POLICY, ExpiryStatus.VALID);
    expect(first).toBe(second);
  });

  it('EXP-20: accepts an ISO date string in addition to a Date object', () => {
    const expiry = addDays(new Date(), 5);
    const isoString = expiry.toISOString().slice(0, 10);
    expect(engine.calculateStatus(isoString, DEFAULT_POLICY, ExpiryStatus.VALID)).toBe(ExpiryStatus.EXPIRING_SOON);
  });
});
