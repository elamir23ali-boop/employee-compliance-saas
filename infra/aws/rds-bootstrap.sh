#!/bin/bash
# E7 Phase 2 section 6 -- RDS bootstrap. Run ON THE EC2 HOST (SSH session).
#
# Self-diagnosing: it runs the preflight checks first and ABORTS before
# mutating anything if RDS refuses BYPASSRLS (001_roles.sql cannot then run
# as written -- that is a CLAUDE.md locked-architecture item + Review Gate,
# report the result rather than editing the migration).
#
# What it does when preflight passes:
#   - CREATE DATABASE e0db (app) + keycloak_db
#   - apply migrations 001,002,003,005,006,007,008,009,010 to e0db, in ONE
#     transaction (004_seed_dev.sql deliberately skipped)
#   - ALTER ROLE app_user / migration_user to the real compliance/prod/database
#     passwords (001 creates them with dev placeholders)
#   - create the keycloak login role, make it own keycloak_db
#   - verify PG version, audit_events grants, FORCE RLS, tenant_isolation_* policies
#
# psql runs from a postgres:18 container (no psql on the host). Creds come
# from Secrets Manager via the instance role (read-only -- works).
set -uo pipefail
export AWS_DEFAULT_REGION=eu-west-1
ENDPOINT="compliance-db.cri4qamqaphw.eu-west-1.rds.amazonaws.com"

fail(){ echo; echo "FATAL: $*" >&2; exit 1; }
command -v jq >/dev/null || sudo dnf install -y -q jq

echo "=== fetch credentials (instance role) ==="
DBSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/database --query SecretString --output text) || fail "cannot read compliance/prod/database"
KCSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/keycloak  --query SecretString --output text) || fail "cannot read compliance/prod/keycloak"
MUSER=$(jq -r .DB_MASTER_USER       <<<"$DBSEC")
MPASS=$(jq -r .DB_MASTER_PASSWORD   <<<"$DBSEC")
APPPW=$(jq -r .DB_APP_PASSWORD      <<<"$DBSEC")
MIGPW=$(jq -r .DB_MIGRATION_PASSWORD<<<"$DBSEC")
KCPW=$(jq  -r .KC_DB_PASSWORD       <<<"$KCSEC")
for v in MUSER MPASS APPPW MIGPW KCPW; do
  eval "x=\${$v}"; [ -n "${x:-}" ] && [ "$x" != null ] || fail "$v missing from secret"
done
echo "master user: $MUSER  |  pw lengths: master ${#MPASS} app ${#APPPW} mig ${#MIGPW} kc ${#KCPW}"

P(){ local db=$1; shift; docker run --rm -i -e PGPASSWORD="$MPASS" postgres:18 \
      psql -h "$ENDPOINT" -U "$MUSER" -d "$db" -v ON_ERROR_STOP=1 "$@"; }

echo
echo "=== [1/6] PREFLIGHT ==="
P postgres -Atc "SELECT version()" || fail "cannot connect to RDS as $MUSER"
P postgres -Atc "DROP ROLE IF EXISTS _pf_b; DROP ROLE IF EXISTS _pf_s" >/dev/null 2>&1
echo "existing target DBs : $(P postgres -Atc "SELECT string_agg(datname,',') FROM pg_database WHERE datname IN ('e0db','compliance_db','keycloak_db')")"
echo "existing app roles  : $(P postgres -Atc "SELECT coalesce(string_agg(rolname,','),'(none)') FROM pg_roles WHERE rolname IN ('app_user','migration_user','keycloak')")"

if P postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname IN ('app_user','migration_user')" | grep -q 1; then
  fail "app_user and/or migration_user ALREADY EXIST -- a previous run applied partially.
   Inspect, then from a psql as $MUSER:  DROP DATABASE IF EXISTS e0db;  DROP ROLE IF EXISTS app_user, migration_user;
   then re-run this script."
fi

echo "-- BYPASSRLS test --"
if P postgres -Atc "CREATE ROLE _pf_b WITH BYPASSRLS" >/dev/null 2>&1; then
  P postgres -Atc "DROP ROLE _pf_b" >/dev/null 2>&1
  echo "   BYPASSRLS: OK"
else
  fail "BYPASSRLS DENIED by this RDS instance.
   001_roles.sql line 3 (CREATE ROLE migration_user ... BYPASSRLS) will not run.
   STOP HERE. This is a locked-architecture decision (CLAUDE.md) + a Review Gate.
   Paste this result back -- do NOT edit 001_roles.sql without human review."
fi

echo "-- SET ROLE test --"
if P postgres -Atc "CREATE ROLE _pf_s" >/dev/null 2>&1 \
   && P postgres -Atc "SET ROLE _pf_s; RESET ROLE" >/dev/null 2>&1 \
   && P postgres -Atc "DROP ROLE _pf_s" >/dev/null 2>&1; then
  echo "   SET ROLE: OK"
else
  P postgres -Atc "DROP ROLE IF EXISTS _pf_s" >/dev/null 2>&1
  fail "SET ROLE round-trip failed -- migrations use SET ROLE migration_user for object ownership"
fi

echo
echo "=== [2/6] CREATE DATABASES ==="
if P postgres -Atc "SELECT 1 FROM pg_database WHERE datname='e0db'" | grep -q 1; then echo "   e0db: exists"; else P postgres -c "CREATE DATABASE e0db" && echo "   e0db: created"; fi
if P postgres -Atc "SELECT 1 FROM pg_database WHERE datname='keycloak_db'" | grep -q 1; then echo "   keycloak_db: exists"; else P postgres -c "CREATE DATABASE keycloak_db" && echo "   keycloak_db: created"; fi

echo
echo "=== [3/6] APPLY MIGRATIONS to e0db (single transaction; 004 skipped) ==="
if ! docker run --rm -i -e PGPASSWORD="$MPASS" postgres:18 \
     psql -h "$ENDPOINT" -U "$MUSER" -d e0db -v ON_ERROR_STOP=1 -1 -f - <<'MIGRATIONS_SQL'
-- E0: role setup. migration_user is BYPASSRLS and must NEVER be used by application code.
CREATE ROLE app_user WITH LOGIN PASSWORD 'app_dev_pass_local';
CREATE ROLE migration_user WITH LOGIN PASSWORD 'migration_dev_pass_local' BYPASSRLS;

GRANT CONNECT ON DATABASE e0db TO app_user;
GRANT CONNECT ON DATABASE e0db TO migration_user;

-- PG15+ revokes CREATE on public from PUBLIC by default; migration_user needs it to run migrations.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE, CREATE ON SCHEMA public TO migration_user;
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
MIGRATIONS_SQL
then
  fail "migration transaction failed and rolled back -- e0db unchanged. Fix and re-run."
fi
echo "   migrations 001-003,005-010 applied"

echo
echo "=== [4/6] SET REAL ROLE PASSWORDS ==="
if ! docker run --rm -i -e PGPASSWORD="$MPASS" postgres:18 \
     psql -h "$ENDPOINT" -U "$MUSER" -d postgres -v ON_ERROR_STOP=1 -v apppw="$APPPW" -v migpw="$MIGPW" <<'PWSQL'
ALTER ROLE app_user       WITH PASSWORD :'apppw';
ALTER ROLE migration_user WITH PASSWORD :'migpw';
PWSQL
then
  fail "ALTER ROLE password step failed"
fi
echo "   app_user + migration_user now use the compliance/prod/database passwords"

echo
echo "=== [5/6] KEYCLOAK ROLE + DB OWNERSHIP ==="
if ! docker run --rm -i -e PGPASSWORD="$MPASS" postgres:18 \
     psql -h "$ENDPOINT" -U "$MUSER" -d postgres -v ON_ERROR_STOP=1 -v kcpw="$KCPW" <<'KCSQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='keycloak') THEN CREATE ROLE keycloak LOGIN; END IF;
END $$;
ALTER ROLE keycloak WITH PASSWORD :'kcpw';
GRANT ALL PRIVILEGES ON DATABASE keycloak_db TO keycloak;
ALTER DATABASE keycloak_db OWNER TO keycloak;
KCSQL
then
  fail "keycloak role / db ownership step failed"
fi
echo "   keycloak role ready; owns keycloak_db"

echo
echo "=== [6/6] VERIFICATION ==="
echo "-- server version (expect 18.x) --"
P e0db -Atc "SELECT current_setting('server_version')"
echo "-- rolbypassrls (expect app_user=f, migration_user=t) --"
P e0db -Atc "SELECT rolname||'='||rolbypassrls FROM pg_roles WHERE rolname IN ('app_user','migration_user') ORDER BY 1"
echo "-- app_user on audit_events (expect SELECT=t INSERT=t UPDATE=f DELETE=f) --"
P e0db -Atc "SELECT 'SELECT='||has_table_privilege('app_user','audit_events','SELECT')||' INSERT='||has_table_privilege('app_user','audit_events','INSERT')||' UPDATE='||has_table_privilege('app_user','audit_events','UPDATE')||' DELETE='||has_table_privilege('app_user','audit_events','DELETE')"
echo "-- ENABLE + FORCE RLS per tenant-owned table (expect t|t for all 8) --"
P e0db -Atc "SELECT relname||' '||relrowsecurity||'|'||relforcerowsecurity FROM pg_class WHERE relname IN ('employees','documents','idempotency_keys','audit_events','expiry_policies','tenant_notification_policies','notification_log','import_batches') ORDER BY relname"
echo "-- tenant_isolation_* policy count (expect 8) / of those with the NULLIF guard (expect 8) --"
P e0db -Atc "SELECT count(*) FILTER (WHERE true)||' total, '||count(*) FILTER (WHERE qual LIKE '%NULLIF%')||' with NULLIF' FROM pg_policies WHERE policyname LIKE 'tenant_isolation_%'"
echo "-- tenants: expect f|f and 0 policies --"
P e0db -Atc "SELECT relrowsecurity||'|'||relforcerowsecurity FROM pg_class WHERE relname='tenants'"
P e0db -Atc "SELECT count(*) FROM pg_policies WHERE tablename='tenants'"

echo
echo "=== DONE ==="
echo "REMAINING (operator, from CloudShell -- the instance role is read-only on secrets):"
echo "  aws secretsmanager get-secret-value --secret-id compliance/prod/database --query SecretString --output text \\"
echo "    | jq -c '.DB_HOST=\"$ENDPOINT\"' \\"
echo "    | aws secretsmanager put-secret-value --secret-id compliance/prod/database --secret-string file:///dev/stdin"
