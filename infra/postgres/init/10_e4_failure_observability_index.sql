-- E4 Pillar 4: index-only migration supporting the new failure-observability
-- read endpoint and worker scan, both of which filter/group notification_log
-- by (tenant_id, status) within a sent_at window. idx_notification_log_dedup
-- (009_e3_reminders_import_dashboard.sql) is ordered (tenant_id, document_id,
-- days_before_expiry, sent_at) and cannot serve a (tenant_id, status,
-- sent_at) predicate. See docs/architecture/decisions.md (ADR-031).
SET ROLE migration_user;

CREATE INDEX idx_notification_log_status_sent_at
  ON notification_log(tenant_id, status, sent_at);

RESET ROLE;
