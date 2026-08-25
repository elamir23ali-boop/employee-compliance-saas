import { Client } from 'pg';

// notification_log is GRANT SELECT, INSERT only to app_user (append-only,
// ADR-025) -- seeded here via a direct app_user connection with tenant
// context set per transaction, the same pattern
// tests/security/notification-policy-rbac.test.ts's NOTIF-RLS-01 already
// uses. document_id seeds as NULL (the same nullable shape the worker itself
// writes for SUPPRESSED, ADR-028 decision 2), keeping seeding independent of
// employee/document fixtures. Not cleaned up afterward -- notification_log is
// intentionally unswept by tests/support/db-cleanup.ts (append-only by
// GRANT, same rationale as audit_events).
export async function seedNotificationLogRows(
  tenantId: string,
  rows: { status: 'SENT' | 'FAILED' | 'SUPPRESSED'; daysBeforeExpiry?: number }[],
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO notification_log (tenant_id, document_id, days_before_expiry, status)
         VALUES ($1, NULL, $2, $3)`,
        [tenantId, row.daysBeforeExpiry ?? 30, row.status],
      );
    }
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}
