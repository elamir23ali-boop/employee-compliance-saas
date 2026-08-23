-- E2: additive-only extension of E0's employees table.
-- full_name (E0, NOT NULL) is retained as a derived display column; the API
-- computes it from first_name/last_name on write. See ADR-021.
SET ROLE migration_user;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS branch TEXT,
  ADD COLUMN IF NOT EXISTS responsible_officer_id TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Soft delete: deleted_at IS NOT NULL means archived
CREATE INDEX idx_employees_active ON employees(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_employees_search ON employees USING GIN (
  to_tsvector('english', coalesce(employee_code,'') || ' ' || coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(department,''))
);

RESET ROLE;
