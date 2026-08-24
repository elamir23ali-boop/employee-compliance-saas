import { Client } from 'pg';

// All E2 tests that create real employees via the API use one of these
// employee_code prefixes. E0's rls.test.ts/pooling.test.ts assert *exact*
// row counts against the original 3x5 seed data, and every test file in
// tests/security/**/*.test.ts + tests/integration/**/*.test.ts runs inside
// the SAME vitest process against the SAME database (fileParallelism:
// false, one shared dev/CI Postgres) -- so any E2 test that creates
// employees and never cleans them up permanently drifts those counts for
// every test file that runs after it, in every subsequent run. This sweep
// is a hard delete via migration_user (BYPASSRLS), which is fine here: it
// is test-teardown infrastructure, not application runtime code -- the
// "NEVER hard-delete employees/documents" rule in CLAUDE.md governs
// EmployeesService/DocumentsService, not test fixtures.
const TEST_EMPLOYEE_CODE_PREFIXES = [
  'EMP-E2-',
  'EMP-RBAC-',
  'EMP-LOCK-',
  'EMP-RLS-',
  'EMP-REM-',
  'EMP-IMP-',
  'EMP-DASH-',
];

export async function cleanupE2TestEmployees(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const likeClause = TEST_EMPLOYEE_CODE_PREFIXES.map((_, i) => `employee_code LIKE $${i + 1}`).join(' OR ');
    const params = TEST_EMPLOYEE_CODE_PREFIXES.map((p) => `${p}%`);
    // documents.employee_id and notification_log.document_id have no ON
    // DELETE CASCADE -- remove dependents first, deepest first
    // (notification_log -> documents -> employees). notification_log is
    // otherwise append-only by GRANT (E3); this is test-teardown
    // infrastructure via migration_user (BYPASSRLS), not application
    // runtime code, same rationale already given above for the hard delete.
    await client.query(
      `DELETE FROM notification_log WHERE document_id IN (
         SELECT id FROM documents WHERE employee_id IN (SELECT id FROM employees WHERE ${likeClause})
       )`,
      params,
    );
    await client.query(
      `DELETE FROM documents WHERE employee_id IN (SELECT id FROM employees WHERE ${likeClause})`,
      params,
    );
    await client.query(`DELETE FROM employees WHERE ${likeClause}`, params);
    // audit_events is intentionally NOT swept here -- it is meant to be a
    // permanent, append-only record even in test runs, and no E0/E2 test
    // asserts an exact audit_events row count.
  } finally {
    await client.end();
  }
}
