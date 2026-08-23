import { Client } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EMPLOYEE_B1 = 'b0000000-0000-0000-0000-000000000001';

async function connectAs(url: string | undefined): Promise<Client> {
  if (!url) throw new Error('connection string not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

describe('E2 tenant isolation (RLS on new/extended tables)', () => {
  let appClient: Client;

  beforeEach(async () => {
    appClient = await connectAs(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    await appClient.end();
  });

  afterAll(async () => {
    // RLS-E2-08 inserts a synthetic EMP-RLS-* employee -- sweep it so E0's
    // exact-row-count assertions (RLS-01/RLS-06) stay accurate on rerun.
    await cleanupE2TestEmployees();
  });

  it('RLS-E2-01: tenant A cannot UPDATE tenant B employees (extended employees table)', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query(`UPDATE employees SET department = 'Hacked' WHERE id = $1`, [EMPLOYEE_B1]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });

  it('RLS-E2-02: tenant A cannot read tenant B documents', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
    const insertRes = await appClient.query(
      `INSERT INTO documents (tenant_id, employee_id, doc_type, doc_number, expiry_date)
       VALUES ($1, $2, 'passport', 'DOC-E2-ISO-01', now() + interval '365 days') RETURNING id`,
      [TENANT_B, EMPLOYEE_B1],
    );
    await appClient.query('COMMIT');
    const documentId = insertRes.rows[0].id as string;

    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query('SELECT * FROM documents WHERE id = $1', [documentId]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });

  it('RLS-E2-03: tenant A cannot read tenant B audit_events', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
    const insertRes = await appClient.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, outcome)
       VALUES ($1, 'test-actor', 'EMPLOYEE_CREATED', 'employee', $2, 'SUCCESS') RETURNING id`,
      [TENANT_B, EMPLOYEE_B1],
    );
    await appClient.query('COMMIT');
    const auditId = insertRes.rows[0].id as string;

    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query('SELECT * FROM audit_events WHERE id = $1', [auditId]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });

  it('RLS-E2-04: tenant A cannot read tenant B expiry_policies', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query('SELECT * FROM expiry_policies WHERE tenant_id = $1', [TENANT_B]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });

  it('RLS-E2-05: no tenant context set -> 0 rows on audit_events and expiry_policies', async () => {
    const auditRes = await appClient.query('SELECT * FROM audit_events');
    const policyRes = await appClient.query('SELECT * FROM expiry_policies');
    expect(auditRes.rowCount).toBe(0);
    expect(policyRes.rowCount).toBe(0);
  });

  it('RLS-E2-06: audit_events, expiry_policies, employees, and documents all have RLS enabled and FORCEd', async () => {
    const res = await appClient.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY($1::text[])`,
      [['audit_events', 'expiry_policies', 'employees', 'documents']],
    );
    expect(res.rowCount).toBe(4);
    for (const row of res.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('RLS-E2-07: app_user has no UPDATE/DELETE grant on audit_events (append-only at the DB level)', async () => {
    const res = await appClient.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'audit_events' AND grantee = current_user`,
    );
    const privileges = res.rows.map((r) => r.privilege_type as string);
    expect(privileges).toContain('SELECT');
    expect(privileges).toContain('INSERT');
    expect(privileges).not.toContain('UPDATE');
    expect(privileges).not.toContain('DELETE');
  });

  it('RLS-E2-08: soft-deleted (archived) employees are excluded by the deleted_at IS NULL filter', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const insertRes = await appClient.query(
      `INSERT INTO employees (tenant_id, employee_code, full_name, first_name, last_name)
       VALUES ($1, $2, 'Soft Deleted', 'Soft', 'Deleted') RETURNING id`,
      [TENANT_A, `EMP-RLS-${Date.now()}`],
    );
    const employeeId = insertRes.rows[0].id as string;
    await appClient.query(`UPDATE employees SET deleted_at = now(), status = 'archived' WHERE id = $1`, [employeeId]);
    const activeRes = await appClient.query('SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [
      employeeId,
    ]);
    await appClient.query('COMMIT');

    expect(activeRes.rowCount).toBe(0);
  });
});
