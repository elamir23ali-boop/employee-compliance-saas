-- Post-E7 standalone fix: additive indexes closing 3 of the 5 O(n)
-- read-path findings from E6 load testing
-- (docs/e6-results/E6_PERFORMANCE_REPORT.md sections 6 and 8, backlog items
-- 2/3/5). See ADR-042. Purely additive: no RLS, grant, or application-code
-- changes -- query results are unaffected, only the plan Postgres chooses.
-- Not "E8" -- that name is reserved for first real pilot customer
-- onboarding (E7_GATE.md's nextEpoch, ADR-041).

-- btree_gin must be created while this session is still the connecting
-- superuser (rds_superuser on RDS) -- migration_user (below) has BYPASSRLS
-- but not extension-install privilege, and SET ROLE downgrades the *whole*
-- session, not just object ownership. Verified locally: running this after
-- SET ROLE fails with "permission denied to create extension", which then
-- cascades into the GIN index failing too ("uuid has no default operator
-- class for access method gin", since btree_gin's opclasses never loaded).
CREATE EXTENSION IF NOT EXISTS btree_gin;

SET ROLE migration_user;

-- Backlog #2: GET /employees/:id/documents (documents.service.ts's
-- findAllForEmployee()) filters (employee_id, deleted_at IS NULL) with no
-- index on employee_id at all -- Parallel Index Scan on idx_documents_tenant
-- then filters the tenant's *entire* doc set in memory.
CREATE INDEX idx_documents_employee ON documents(employee_id) WHERE deleted_at IS NULL;

-- Backlog #3: GET /employees?q=<term> never uses idx_employees_search
-- (006_employees_extended.sql) once the RLS tenant_id predicate is added --
-- 0 idx_scan across every E6 load run. Fold tenant_id into the GIN index
-- itself via btree_gin so a single Index Scan satisfies both predicates.
-- The old index has no remaining use (every query is tenant-scoped via RLS)
-- and only costs write amplification, so it's dropped here.
DROP INDEX IF EXISTS idx_employees_search;

CREATE INDEX idx_employees_search_tenant ON employees USING GIN (
  tenant_id,
  to_tsvector('english', coalesce(employee_code,'') || ' ' || coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(department,''))
) WHERE deleted_at IS NULL;

-- Backlog #5: GET /employees?page=N (employees.service.ts's findAll(),
-- .orderBy(employees.createdAt)) heapsorts the tenant's whole active set via
-- idx_employees_tenant. This composite lets the planner satisfy the RLS
-- tenant_id predicate and the ORDER BY from one index, with no sort step.
CREATE INDEX idx_employees_list ON employees(tenant_id, created_at) WHERE deleted_at IS NULL;

RESET ROLE;
