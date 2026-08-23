-- E2: data-driven expiry policies, one row per (tenant, doc_type).
SET ROLE migration_user;

CREATE TABLE expiry_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('passport','residence','badge')),
  warning_days_1 INTEGER NOT NULL DEFAULT 90,
  warning_days_2 INTEGER NOT NULL DEFAULT 60,
  warning_days_3 INTEGER NOT NULL DEFAULT 30,
  critical_days INTEGER NOT NULL DEFAULT 14,
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  auto_block BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, doc_type)
);

ALTER TABLE expiry_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_expiry_policies ON expiry_policies
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON expiry_policies TO app_user;

-- Default policy rows for every existing (seeded) tenant + doc type.
INSERT INTO expiry_policies (tenant_id, doc_type)
SELECT id, doc_type FROM tenants, (VALUES ('passport'),('residence'),('badge')) AS t(doc_type)
ON CONFLICT (tenant_id, doc_type) DO NOTHING;

RESET ROLE;
