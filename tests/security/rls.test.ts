import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FORGED_TENANT = 'deadbeef-dead-dead-dead-deadbeefcafe';

async function connectAs(url: string | undefined): Promise<Client> {
  if (!url) throw new Error('connection string not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

describe('RLS tests', () => {
  let appClient: Client;

  beforeEach(async () => {
    appClient = await connectAs(process.env.DATABASE_URL);
  });

  afterEach(async () => {
    await appClient.end();
  });

  it('RLS-01: tenant A reads own data', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
    const res = await appClient.query('SELECT * FROM employees');
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(5);
    expect(res.rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });

  it('RLS-02: tenant context B, WHERE clause targets tenant A -> 0 rows', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
    const res = await appClient.query('SELECT * FROM employees WHERE tenant_id = $1', [TENANT_A]);
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });

  it('RLS-03: no tenant context set -> 0 rows', async () => {
    const res = await appClient.query('SELECT * FROM employees');
    expect(res.rowCount).toBe(0);
  });

  it('RLS-04: forged non-existent tenant UUID -> 0 rows', async () => {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [FORGED_TENANT]);
    const res = await appClient.query('SELECT * FROM employees');
    await appClient.query('COMMIT');

    expect(res.rowCount).toBe(0);
  });

  it('RLS-05: app_user cannot assume migration_user role', async () => {
    await expect(appClient.query('SET SESSION ROLE migration_user')).rejects.toThrow();
  });

  it('RLS-06: migration_user bypasses RLS -> sees all 15 rows', async () => {
    const migrationClient = await connectAs(process.env.DATABASE_MIGRATION_URL);
    try {
      const res = await migrationClient.query('SELECT * FROM employees');
      expect(res.rowCount).toBe(15);
    } finally {
      await migrationClient.end();
    }
  });
});
