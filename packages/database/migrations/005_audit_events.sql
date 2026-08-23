-- E2: append-only audit log. NO UPDATE, NO DELETE by app_user, ever.
-- See docs/architecture/decisions.md (ADR-020) for the SAVEPOINT pattern
-- that lets AuditService.log() write here inside the caller's business
-- transaction without a failed audit INSERT rolling back that business op.
SET ROLE migration_user;

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  request_id TEXT,
  actor_user_id TEXT,
  actor_ip INET,
  actor_user_agent TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_state JSONB,
  after_state JSONB,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILED', 'PARTIAL')),
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_tenant_created ON audit_events(tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_events(tenant_id, entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_events(tenant_id, actor_user_id);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit ON audit_events
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- app_user can INSERT and SELECT but NEVER UPDATE or DELETE -- audit_events
-- must be append-only from application code (CLAUDE.md: "NEVER bypass RLS
-- in application code" + "audit events cannot be modified or deleted").
GRANT SELECT, INSERT ON audit_events TO app_user;
REVOKE UPDATE, DELETE ON audit_events FROM app_user;

RESET ROLE;
