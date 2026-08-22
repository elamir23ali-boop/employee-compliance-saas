-- E0: RLS policies. tenants has NO policy (looked up before tenant context exists).
--
-- NOTE ON NULLIF(...): after SET LOCAL / set_config(..., true) commits, a
-- custom (placeholder) GUC that had no prior session-level value reverts to
-- '' (empty string), NOT NULL -- confirmed empirically against Postgres 18.
-- A bare `current_setting(...) IS NOT NULL` check therefore lets '' through,
-- and the subsequent ::uuid cast then throws instead of the query cleanly
-- returning zero rows. NULLIF collapses '' to NULL first so both "never set"
-- and "reset after commit" behave identically: zero rows, no error. This is
-- purely a robustness fix (fail-closed either way, no data ever leaked) --
-- see /docs/e0/decisions.md for the discovery (POOL-01).
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employees ON employees
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_documents ON documents
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_idempotency ON idempotency_keys
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
