-- E3 Phase 2: additive schema for the Reminder Engine (Pillar 2) and Excel
-- Import/Export (Pillar 3). No application code in this migration -- see
-- docs/architecture/decisions.md (ADR-025) for the schema decisions made
-- here, ahead of Phases 3-5 implementing the services that use these
-- tables.
SET ROLE migration_user;

-- One row per tenant. reminder_days_before is tenant-configurable (no
-- hardcoded retention/schedule, per CLAUDE.md's "No hardcoded retention
-- period" rule generalized to notification cadence); default mirrors the
-- E3 spec's example (90/60/30/14/7/1 days before expiry).
CREATE TABLE tenant_notification_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  reminder_days_before INTEGER[] NOT NULL DEFAULT '{90,60,30,14,7,1}',
  email_from TEXT,
  email_template_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

ALTER TABLE tenant_notification_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notification_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_notification_policies ON tenant_notification_policies
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_notification_policies TO app_user;

-- Append-only dispatch record, same append-only rationale as audit_events
-- (005_audit_events.sql): a notification, once sent/failed/suppressed, is a
-- historical fact, not something application code should revise. Only
-- document_id is stored -- never employee name, document number, or email
-- address (CLAUDE.md: "NEVER log PII"; the email itself is resolved at
-- dispatch time by the worker, from document_id -> employee, never carried
-- in a queue payload or persisted here).
CREATE TABLE notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  document_id UUID REFERENCES documents(id),
  notification_type TEXT NOT NULL DEFAULT 'EXPIRY_REMINDER'
    CHECK (notification_type IN ('EXPIRY_REMINDER')),
  days_before_expiry INTEGER NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('SENT', 'FAILED', 'SUPPRESSED')),
  error_message TEXT
);

CREATE INDEX idx_notification_log_dedup
  ON notification_log(tenant_id, document_id, days_before_expiry, sent_at);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_notification_log ON notification_log
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- app_user can INSERT and SELECT but NEVER UPDATE or DELETE -- same
-- append-only rationale as audit_events.
GRANT SELECT, INSERT ON notification_log TO app_user;

-- One row per upload attempt. file_hash (SHA-256 of the uploaded file's
-- content) isn't listed among the E3 spec's bulleted import_batches fields,
-- but the spec's own idempotency rule ("same file re-uploaded, detected by
-- SHA-256 hash of content -> return existing batch result") is unbuildable
-- without persisting that hash somewhere to compare against, so it's added
-- here as the column that rule needs.
CREATE TABLE import_batches (
  import_batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  -- JWT subject, not a display name -- same convention as
  -- audit_events.actor_user_id (005_audit_events.sql).
  created_by TEXT,
  UNIQUE (tenant_id, file_hash)
);

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_import_batches ON import_batches
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON import_batches TO app_user;

-- Dashboard aggregation index (E3 Pillar 4): documentStats groups by
-- (doc_type, expiry_status) per tenant. idx_documents_expiry and
-- idx_documents_status (007_documents_extended.sql) already cover
-- (tenant_id, expiry_date) and (tenant_id, expiry_status) individually --
-- this is the new composite the dashboard's per-type breakdown needs that
-- neither of those serves.
CREATE INDEX idx_documents_type_status
  ON documents(tenant_id, doc_type, expiry_status) WHERE deleted_at IS NULL;

RESET ROLE;
