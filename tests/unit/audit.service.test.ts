import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../apps/api/src/audit/audit.service';
import type { DbTransaction } from '@ecs/database';
import type { AuditContext } from '@ecs/shared';

interface MockTxState {
  executeCalls: number;
  insertedValues: Record<string, unknown> | undefined;
}

function createMockTx(opts: { insertShouldFail?: boolean } = {}): { tx: DbTransaction; state: MockTxState } {
  const state: MockTxState = { executeCalls: 0, insertedValues: undefined };
  const tx = {
    execute: vi.fn(async () => {
      state.executeCalls += 1;
      return { rows: [] };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: Record<string, unknown>) => {
        if (opts.insertShouldFail) {
          throw new Error('simulated audit insert failure');
        }
        state.insertedValues = vals;
        return [];
      }),
    })),
  };
  return { tx: tx as unknown as DbTransaction, state };
}

const CONTEXT: AuditContext = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  actorUserId: 'user-0000-1111-2222-333344445555',
  requestId: 'req-id',
  correlationId: 'corr-id',
};

describe('AuditService.log', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('AUDIT-01: writes the correct action type and entity into the row', async () => {
    const service = new AuditService();
    const { tx, state } = createMockTx();

    await service.log(tx, CONTEXT, 'EMPLOYEE_CREATED', 'employee', 'e0000000-0000-0000-0000-000000000001', null, {
      fullName: 'Employee_A1',
    }, 'SUCCESS');

    expect(state.insertedValues?.action).toBe('EMPLOYEE_CREATED');
    expect(state.insertedValues?.entityType).toBe('employee');
    expect(state.insertedValues?.outcome).toBe('SUCCESS');
  });

  it('AUDIT-02: captures before/after state exactly (names/doc numbers are allowed in DB state)', async () => {
    const service = new AuditService();
    const { tx, state } = createMockTx();

    const before = { fullName: 'Employee_A1', department: 'Operations' };
    const after = { fullName: 'Employee_A1', department: 'Finance' };
    await service.log(tx, CONTEXT, 'EMPLOYEE_UPDATED', 'employee', 'e0000000-0000-0000-0000-000000000001', before, after, 'SUCCESS');

    expect(state.insertedValues?.beforeState).toEqual(before);
    expect(state.insertedValues?.afterState).toEqual(after);
  });

  it('AUDIT-03: strips password/secret/token/credential-like keys from before/after state', async () => {
    const service = new AuditService();
    const { tx, state } = createMockTx();

    const after = { fullName: 'Employee_A1', password: 'hunter2', apiSecret: 'xyz', authToken: 'abc' };
    await service.log(tx, CONTEXT, 'EMPLOYEE_UPDATED', 'employee', 'e0000000-0000-0000-0000-000000000001', null, after, 'SUCCESS');

    expect(state.insertedValues?.afterState).toEqual({ fullName: 'Employee_A1' });
  });

  it('AUDIT-04: never logs PII -- structured log lines carry only prefixed IDs, no names/emails', async () => {
    const service = new AuditService();
    const { tx } = createMockTx();

    await service.log(
      tx,
      CONTEXT,
      'EMPLOYEE_CREATED',
      'employee',
      'e0000000-0000-0000-0000-000000000001',
      null,
      { fullName: 'Employee_A1', email: 'employee_a1@example.com' },
      'SUCCESS',
    );

    expect(logSpy).toHaveBeenCalled();
    const loggedLine = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(loggedLine).not.toContain('Employee_A1');
    expect(loggedLine).not.toContain('employee_a1@example.com');
    expect(loggedLine).not.toContain(CONTEXT.tenantId); // only an 8-char prefix should appear
    expect(loggedLine).toContain(CONTEXT.tenantId.slice(0, 8));
  });

  it('AUDIT-05: an audit INSERT failure never throws out of log() -- business tx must be able to continue', async () => {
    const service = new AuditService();
    const { tx } = createMockTx({ insertShouldFail: true });

    await expect(
      service.log(tx, CONTEXT, 'EMPLOYEE_CREATED', 'employee', 'e0000000-0000-0000-0000-000000000001', null, {}, 'SUCCESS'),
    ).resolves.toBeUndefined();
  });

  it('AUDIT-06: on INSERT failure, rolls back to the savepoint (does not poison the caller transaction)', async () => {
    const service = new AuditService();
    const { tx, state } = createMockTx({ insertShouldFail: true });

    await service.log(tx, CONTEXT, 'EMPLOYEE_CREATED', 'employee', 'e0000000-0000-0000-0000-000000000001', null, {}, 'SUCCESS');

    // SAVEPOINT + ROLLBACK TO SAVEPOINT -- exactly 2 execute() calls, insert never committed a row.
    expect(state.executeCalls).toBe(2);
    expect(state.insertedValues).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('AUDIT-07: on success, issues SAVEPOINT + RELEASE SAVEPOINT around the INSERT', async () => {
    const service = new AuditService();
    const { tx, state } = createMockTx();

    await service.log(tx, CONTEXT, 'EMPLOYEE_CREATED', 'employee', 'e0000000-0000-0000-0000-000000000001', null, {}, 'SUCCESS');

    expect(state.executeCalls).toBe(2);
    expect(state.insertedValues).toBeDefined();
  });
});
