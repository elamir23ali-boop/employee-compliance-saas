#!/bin/bash
# E7 Phase 4 -- seed a small amount of synthetic data into the live prod DB
# and provision matching Keycloak seed users, so the deployed stack has
# content to smoke-test against. Run ON THE EC2 HOST (SSM).
#
# Deliberately REUSES the E6 seed tooling unchanged
# (tools/seed/{config,db,generate,keycloak-users}.ts) rather than a new
# script: same app_user/RLS-respecting write path (tools/seed/db.ts's
# withTenant() -- SET LOCAL app.current_tenant_id before every insert,
# never migration_user), same synthetic-only/@test.invalid-domain data,
# same idempotent skip-if-already-seeded check. Only the --count differs
# from E6's 100K load-test volume -- this is a staging smoke-test amount
# on a t3.micro/db.t3.micro host, not a load test.
#
# The host has no repo checkout (curl + sha256 pin from GitHub, same
# pattern as deploy-stack.sh) and no host-level Node -- both seed scripts
# run inside a throwaway `node:22-slim` container. generate.ts needs
# nothing but outbound TCP to RDS (works on any docker network on this
# host); keycloak-users.ts is joined to the compose network
# (`compliance_default`) to reach Keycloak's admin API at
# http://keycloak:8080 directly, rather than hairpinning back out through
# the public domain.
#
# Usage: bash seed-smoke-data.sh [count]   # default 300 total employees,
#                                           # split across the 5 seed
#                                           # tenants by weight (config.ts)
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

COUNT="${1:-300}"
export AWS_DEFAULT_REGION=eu-west-1
REPO_RAW="https://raw.githubusercontent.com/elamir23ali-boop/employee-compliance-saas/e7/aws-deployment"
WORKDIR=/opt/compliance/seed-tools

CONFIG_SHA256="a78be442f02ce55b9da85bc96a99689bae750306554696dd0b41a785afc1c613"
DB_SHA256="e11ea828d27bc8d1bf9a7954a6c7864f85ac49a2623a5d581d27bd9da36ddad9"
GENERATE_SHA256="3c7cb3dda57f0fc6ab14fc56246756cd3c29008cc55490e9e208ce726a5a7bf8"
KCUSERS_SHA256="84fcd14191d8dfb5e20a4e9ca8671551bfa62be3da56dc0ee34cd9cbce6cb219"

fail(){ echo; echo "FATAL: $*" >&2; exit 1; }
verify(){ # verify <file> <expected-sha256>
  local f=$1 exp=$2 got
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$got" = "$exp" ] || fail "$f checksum mismatch: got $got, expected $exp -- fetch corrupted or file changed upstream, do not proceed"
}
command -v jq >/dev/null || dnf install -y -q jq

mkdir -p "$WORKDIR" || fail "mkdir $WORKDIR failed"
cd "$WORKDIR" || fail "cd $WORKDIR failed"

echo "=== [1/5] fetch seed-tool files from GitHub ==="
curl -fsSL "$REPO_RAW/tools/seed/config.ts" -o config.ts || fail "curl config.ts failed"
curl -fsSL "$REPO_RAW/tools/seed/db.ts" -o db.ts || fail "curl db.ts failed"
curl -fsSL "$REPO_RAW/tools/seed/generate.ts" -o generate.ts || fail "curl generate.ts failed"
curl -fsSL "$REPO_RAW/tools/seed/keycloak-users.ts" -o keycloak-users.ts || fail "curl keycloak-users.ts failed"
verify config.ts "$CONFIG_SHA256"
verify db.ts "$DB_SHA256"
verify generate.ts "$GENERATE_SHA256"
verify keycloak-users.ts "$KCUSERS_SHA256"
echo "   fetched + verified 4 files"

echo
echo "=== [2/5] fetch secrets (instance role, read-only) ==="
DBSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/database --query SecretString --output text) || fail "cannot read compliance/prod/database"
KCSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/keycloak  --query SecretString --output text) || fail "cannot read compliance/prod/keycloak"

DB_HOST=$(jq -r .DB_HOST <<<"$DBSEC")
DB_APP_USER=$(jq -r .DB_APP_USER <<<"$DBSEC")
DB_APP_PASSWORD=$(jq -r .DB_APP_PASSWORD <<<"$DBSEC")
KC_ADMIN_PASSWORD=$(jq -r .KC_ADMIN_PASSWORD <<<"$KCSEC")

for v in DB_HOST DB_APP_USER DB_APP_PASSWORD KC_ADMIN_PASSWORD; do
  eval "x=\${$v}"; [ -n "${x:-}" ] && [ "$x" != null ] || fail "$v missing from secret"
done

# Same DB_NAME/sslmode reasoning as deploy-stack.sh's [4/7]: e0db is the
# migrated database, rds.force_ssl=1 requires TLS, and this repo's
# pg-connection-string version only maps `no-verify` to "encrypt, don't
# validate" (see deploy-stack.sh's own comment for the full story).
DATABASE_URL="postgresql://${DB_APP_USER}:${DB_APP_PASSWORD}@${DB_HOST}:5432/e0db?sslmode=no-verify"
echo "   db host: $DB_HOST"

echo
echo "=== [3/5] install seed-tool runtime deps (throwaway container) ==="
# tsx transpiles TS itself (esbuild) -- no `typescript`/`@types/*` needed
# at runtime, deliberately not installed.
cat > package.json <<'PKGEOF'
{ "name": "e7-seed-tools", "private": true }
PKGEOF
docker run --rm -v "$WORKDIR":/seed -w /seed node:22-slim \
  npm install --no-save --no-audit --no-fund pg@8 @faker-js/faker@10 tsx@4 \
  || fail "npm install (seed deps) failed"
echo "   installed"

echo
echo "=== [4/5] generate.ts -- seed employees/documents (--count=$COUNT) ==="
docker run --rm -v "$WORKDIR":/seed -w /seed \
  -e DATABASE_URL="$DATABASE_URL" \
  node:22-slim npx tsx generate.ts --count="$COUNT" \
  || fail "generate.ts failed"

echo
echo "=== [5/5] keycloak-users.ts -- provision seed hr-manager users ==="
docker run --rm --network compliance_default -v "$WORKDIR":/seed -w /seed \
  -e KEYCLOAK_ADMIN_URL="http://keycloak:8080" \
  -e KEYCLOAK_ADMIN_USER="admin" \
  -e KEYCLOAK_ADMIN_PASS="$KC_ADMIN_PASSWORD" \
  node:22-slim npx tsx keycloak-users.ts \
  || fail "keycloak-users.ts failed"

echo
echo "=== SEED: DONE ==="
