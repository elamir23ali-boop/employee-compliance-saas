-- E0: schema, owned by migration_user (superuser session assumes the role for object ownership).
SET ROLE migration_user;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  employee_code TEXT NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, employee_code)
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  employee_id UUID REFERENCES employees(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('passport', 'residence', 'badge')),
  doc_number TEXT NOT NULL,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'valid',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_employees_tenant ON employees(tenant_id);
CREATE INDEX idx_documents_tenant ON documents(tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, employees, documents, idempotency_keys TO app_user;

RESET ROLE;
