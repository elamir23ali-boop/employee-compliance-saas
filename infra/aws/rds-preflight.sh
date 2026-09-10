#!/bin/bash
# E7 Phase 2 section 6 -- RDS bootstrap PREFLIGHT. Run on the EC2 host (SSH).
# Read-only except for two throwaway test roles it creates AND drops.
# Answers the three things that decide the real migration sequence:
#   - can compliance_master reach the DB, and what PG version
#   - can it CREATE ROLE ... BYPASSRLS   (RDS rds_superuser usually CANNOT)
#   - can it SET ROLE to a role it just created
set -uo pipefail
export AWS_DEFAULT_REGION=eu-west-1
RDS_ENDPOINT="compliance-db.cri4qamqaphw.eu-west-1.rds.amazonaws.com"

command -v jq >/dev/null || sudo dnf install -y -q jq

echo "== docker =="
docker --version
docker compose version

echo "== fetch master creds (instance role, read-only) =="
DBSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/database --query SecretString --output text)
MUSER=$(printf '%s' "$DBSEC" | jq -r .DB_MASTER_USER)
MPASS=$(printf '%s' "$DBSEC" | jq -r .DB_MASTER_PASSWORD)
echo "master user: $MUSER  (pw len ${#MPASS})"

run() {
  docker run --rm -i -e PGPASSWORD="$MPASS" postgres:18 \
    psql -h "$RDS_ENDPOINT" -U "$MUSER" -d postgres -v ON_ERROR_STOP=1 -Atc "$1"
}

echo "== connectivity + version =="
run "SELECT version()"
run "SELECT current_user || ' / ' || session_user"

echo "== existing databases =="
run "SELECT datname FROM pg_database WHERE datname IN ('e0db','compliance_db','keycloak_db') ORDER BY 1"

echo "== TEST 1: CREATE ROLE ... BYPASSRLS =="
if run "CREATE ROLE _pf_bypassrls WITH BYPASSRLS"; then
  run "DROP ROLE _pf_bypassrls"
  echo "RESULT bypassrls: OK"
else
  echo "RESULT bypassrls: DENIED  (expected on RDS -- 001_roles.sql needs handling)"
fi

echo "== TEST 2: CREATE ROLE + SET ROLE round-trip =="
if run "CREATE ROLE _pf_setrole"; then
  run "SET ROLE _pf_setrole; RESET ROLE"
  run "DROP ROLE _pf_setrole"
  echo "RESULT set_role: OK"
else
  echo "RESULT set_role: DENIED"
fi

echo "== preflight done =="
