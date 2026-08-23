-- E2: additive-only extension of E0's documents table.
SET ROLE migration_user;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS issue_date DATE,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exception_reason TEXT;

-- Expiry status is computed by the Expiry Engine — stored as a cache for
-- read performance, never treated as a source of truth by itself.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS expiry_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (expiry_status IN ('VALID','EXPIRING_SOON','RENEWAL_IN_PROGRESS','EXCEPTION','EXPIRED','BLOCKED'));

CREATE INDEX idx_documents_expiry ON documents(tenant_id, expiry_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_status ON documents(tenant_id, expiry_status) WHERE deleted_at IS NULL;

RESET ROLE;
