import { describe, expect, it, vi } from 'vitest';
import { EmployeesService } from '../../apps/api/src/employees/employees.service';
import type { CreateEmployeeDto, UpdateEmployeeDto } from '@ecs/shared';

function selectChain(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: unknown[]) => void) => resolve(rows),
  };
  return chain;
}

function insertChain(handler: (values: Record<string, unknown>) => unknown[] | Promise<unknown[]>) {
  return {
    values: (v: Record<string, unknown>) => ({
      returning: async () => handler(v),
    }),
  };
}

function updateChain(handler: (setValues: Record<string, unknown>) => unknown[] | Promise<unknown[]>) {
  return {
    set: (setValues: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => handler(setValues),
      }),
    }),
  };
}

interface FakeTxOverrides {
  select?: () => ReturnType<typeof selectChain>;
  insert?: () => ReturnType<typeof insertChain>;
  update?: () => ReturnType<typeof updateChain>;
}

function makeService(overrides: FakeTxOverrides = {}) {
  const fakeTx = {
    execute: vi.fn(async () => ({})),
    select: overrides.select ?? (() => selectChain([])),
    insert: overrides.insert ?? (() => insertChain(() => [])),
    update: overrides.update ?? (() => updateChain(() => [])),
  };
  const drizzle = { db: { transaction: async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx) } };
  const auditService = { log: vi.fn(async () => undefined) };
  const service = new EmployeesService(drizzle as never, auditService as never);
  return { service, auditService };
}

const CONTEXT = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorUserId: 'actor-1' };

describe('EmployeesService', () => {
  it('EMP-UNIT-01: stale version on update returns a 409 Conflict with detail=version_mismatch', async () => {
    const before = {
      id: 'e1',
      tenantId: CONTEXT.tenantId,
      employeeCode: 'EMP-1',
      fullName: 'A B',
      firstName: 'A',
      lastName: 'B',
      version: 2,
      deletedAt: null,
    };
    const { service } = makeService({
      select: () => selectChain([before]),
      // Simulates the DB's `WHERE version = $staleVersion` matching 0 rows.
      update: () => updateChain(() => []),
    });

    const dto: UpdateEmployeeDto = { firstName: 'A2', version: 1 };
    await expect(service.update(CONTEXT.tenantId, 'e1', dto, CONTEXT)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ detail: 'version_mismatch' }),
    });
  });

  it('EMP-UNIT-02: archive() soft-deletes -- sets deletedAt, never issues a hard DELETE', async () => {
    const before = { id: 'e1', tenantId: CONTEXT.tenantId, deletedAt: null, status: 'active' };
    const archivedAt = new Date('2026-01-01T00:00:00Z');
    const { service } = makeService({
      select: () => selectChain([before]),
      update: () => updateChain(() => [{ id: 'e1', deletedAt: archivedAt, status: 'archived' }]),
    });

    const result = await service.archive(CONTEXT.tenantId, 'e1', CONTEXT);
    expect(result).toEqual({ id: 'e1', archivedAt: archivedAt.toISOString() });
  });

  it('EMP-UNIT-03: duplicate employee_code surfaces as a 409 with detail=duplicate_code', async () => {
    const { service } = makeService({
      insert: () =>
        insertChain(() => {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        }),
    });

    const dto: CreateEmployeeDto = { employeeCode: 'EMP-1', firstName: 'A', lastName: 'B' };
    await expect(service.create(CONTEXT.tenantId, dto, CONTEXT)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ detail: 'duplicate_code' }),
    });
  });

  it('EMP-UNIT-04: tenant_id is always taken from the explicit service argument, never from the DTO', async () => {
    let capturedInsertValues: Record<string, unknown> | undefined;
    const { service } = makeService({
      insert: () =>
        insertChain((values) => {
          capturedInsertValues = values;
          return [{ id: 'e1', ...values }];
        }),
    });

    // Simulates a caller that (incorrectly, or maliciously) smuggled a
    // tenantId into the DTO body -- CreateEmployeeDto has no such field, so
    // this can only happen via an `as` cast, exactly like a hand-crafted
    // request body would bypass compile-time typing.
    const dto = {
      employeeCode: 'EMP-1',
      firstName: 'A',
      lastName: 'B',
      tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    } as unknown as CreateEmployeeDto;

    await service.create(CONTEXT.tenantId, dto, CONTEXT);

    expect(capturedInsertValues?.tenantId).toBe(CONTEXT.tenantId);
    expect(capturedInsertValues?.tenantId).not.toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });
});
