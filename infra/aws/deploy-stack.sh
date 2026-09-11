#!/bin/bash
# E7 Phase 3 Sub-phase B -- deploy the app stack to the compliance-app EC2
# host. Run ON THE EC2 HOST (SSM session).
#
# Delivery: the host has no repo checkout, but the repo is public on
# GitHub, so this script (and the two files it needs -- the compose file
# and the Keycloak realm export) are fetched over HTTPS from
# raw.githubusercontent.com rather than pasted/base64-transferred as a
# blob (the earlier rds-bootstrap.sh approach -- abandoned here after
# repeated hand-transcription corruption trying to relay a ~30KB blob
# through chat; a git push + curl is the reliable channel). Fetched files
# are sha256-verified against the checksums this script pins, so a
# mismatch aborts before anything is written to disk.
#
# What it does:
#   - curls infra/aws/docker-compose.prod.yml and
#     infra/docker/keycloak/realm-export.json from GitHub (branch
#     e7/aws-deployment) into /opt/compliance/, verifying each against a
#     pinned sha256
#   - fetches the 5 compliance/prod/* secrets via the instance role
#     (read-only -- works, same as rds-bootstrap.sh) and renders
#     /opt/compliance/.env.prod
#   - ECR login + `docker compose pull` + `up -d`
#   - polls health/ready, the Keycloak realm endpoint, and the worker's
#     startup log line; prints PASS/FAIL rather than assuming success
#
# Does NOT touch the security group, DNS, or TLS -- Sub-phase C. api/
# keycloak stay bound to 127.0.0.1 only (see docker-compose.prod.yml) so
# nothing here is reachable from the internet yet, deliberately, even
# though compliance-app-sg already allows 80/443 from 0.0.0.0/0.
set -uo pipefail
export AWS_DEFAULT_REGION=eu-west-1
REGISTRY="218201720464.dkr.ecr.eu-west-1.amazonaws.com"
TAG="693777a"
REPO_RAW="https://raw.githubusercontent.com/elamir23ali-boop/employee-compliance-saas/e7/aws-deployment"
COMPOSE_SHA256="edf0130e6169a716aa8c5f037929ced7a69b111e8133735fc420fdde55c4b18f"
REALM_SHA256="090ee72359bf0af36edea968d93e0e3aa9c25d1f4cbb9591caea6f0077ac2455"

fail(){ echo; echo "FATAL: $*" >&2; exit 1; }
verify(){ # verify <file> <expected-sha256>
  local f=$1 exp=$2 got
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$got" = "$exp" ] || fail "$f checksum mismatch: got $got, expected $exp -- fetch corrupted or file changed upstream, do not proceed"
}
command -v jq >/dev/null || sudo dnf install -y -q jq

mkdir -p /opt/compliance/keycloak

echo "=== [1/6] fetch compose file + realm export from GitHub ==="
curl -fsSL "$REPO_RAW/infra/aws/docker-compose.prod.yml" -o /opt/compliance/docker-compose.prod.yml || fail "curl docker-compose.prod.yml failed"
curl -fsSL "$REPO_RAW/infra/docker/keycloak/realm-export.json" -o /opt/compliance/keycloak/realm-export.json || fail "curl realm-export.json failed"
verify /opt/compliance/docker-compose.prod.yml "$COMPOSE_SHA256"
verify /opt/compliance/keycloak/realm-export.json "$REALM_SHA256"
echo "   fetched + verified both files"

echo
echo "=== [2/6] fetch secrets (instance role) ==="
DBSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/database --query SecretString --output text) || fail "cannot read compliance/prod/database"
REDISSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/redis   --query SecretString --output text) || fail "cannot read compliance/prod/redis"
KCSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/keycloak  --query SecretString --output text) || fail "cannot read compliance/prod/keycloak"
SMTPSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/smtp    --query SecretString --output text) || fail "cannot read compliance/prod/smtp"
APPSEC=$(aws secretsmanager get-secret-value --secret-id compliance/prod/app     --query SecretString --output text) || fail "cannot read compliance/prod/app"

DB_HOST=$(jq -r .DB_HOST <<<"$DBSEC")
DB_APP_USER=$(jq -r .DB_APP_USER <<<"$DBSEC")
DB_APP_PASSWORD=$(jq -r .DB_APP_PASSWORD <<<"$DBSEC")
DB_MIGRATION_USER=$(jq -r .DB_MIGRATION_USER <<<"$DBSEC")
DB_MIGRATION_PASSWORD=$(jq -r .DB_MIGRATION_PASSWORD <<<"$DBSEC")
REDIS_PASSWORD=$(jq -r .REDIS_PASSWORD <<<"$REDISSEC")
KC_HOSTNAME=$(jq -r .KC_HOSTNAME <<<"$KCSEC")
KC_DB_PASSWORD=$(jq -r .KC_DB_PASSWORD <<<"$KCSEC")
KC_ADMIN_PASSWORD=$(jq -r .KC_ADMIN_PASSWORD <<<"$KCSEC")
SMTP_HOST=$(jq -r .SMTP_HOST <<<"$SMTPSEC")
SMTP_PORT=$(jq -r .SMTP_PORT <<<"$SMTPSEC")
SMTP_USER=$(jq -r .SMTP_USER <<<"$SMTPSEC")
SMTP_PASS=$(jq -r .SMTP_PASS <<<"$SMTPSEC")
NODE_ENV=$(jq -r .NODE_ENV <<<"$APPSEC")
PORT=$(jq -r .PORT <<<"$APPSEC")

for v in DB_HOST DB_APP_USER DB_APP_PASSWORD DB_MIGRATION_USER DB_MIGRATION_PASSWORD \
         REDIS_PASSWORD KC_HOSTNAME KC_DB_PASSWORD KC_ADMIN_PASSWORD \
         SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS NODE_ENV PORT; do
  eval "x=\${$v}"; [ -n "${x:-}" ] && [ "$x" != null ] || fail "$v missing from secret"
done
echo "   db host: $DB_HOST  |  kc host: $KC_HOSTNAME  |  node_env: $NODE_ENV"

echo
echo "=== [3/6] render .env.prod ==="
# DB_NAME deliberately hardcoded to e0db, NOT read from the DB_NAME key in
# compliance/prod/database -- the RDS instance itself was created with
# --db-name compliance_db (ADR-038's own recorded deviation), and e0db is
# the database rds-bootstrap.sh actually created and migrated. Trusting an
# unread secret field here risks silently pointing prod at the empty,
# unmigrated compliance_db.
cat > /opt/compliance/.env.prod <<ENVEOF
ECR_REGISTRY=${REGISTRY}
IMAGE_TAG=${TAG}
NODE_ENV=${NODE_ENV}
PORT=${PORT}
DB_HOST=${DB_HOST}
DATABASE_URL=postgresql://${DB_APP_USER}:${DB_APP_PASSWORD}@${DB_HOST}:5432/e0db
DATABASE_MIGRATION_URL=postgresql://${DB_MIGRATION_USER}:${DB_MIGRATION_PASSWORD}@${DB_HOST}:5432/e0db
REDIS_PASSWORD=${REDIS_PASSWORD}
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/1
KC_HOSTNAME=${KC_HOSTNAME}
KC_DB_PASSWORD=${KC_DB_PASSWORD}
KC_ADMIN_PASSWORD=${KC_ADMIN_PASSWORD}
KEYCLOAK_ISSUER=https://${KC_HOSTNAME}/realms/e0-test
KEYCLOAK_JWKS_URI=https://${KC_HOSTNAME}/realms/e0-test/protocol/openid-connect/certs
KEYCLOAK_CLIENT_ID=e0-api
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
# Not in compliance/prod/smtp (only HOST/PORT/USER/PASS are secret) --
# these two are non-secret provider config, defaulted here rather than
# invented as new Secrets Manager fields.
SMTP_SECURE=true
SMTP_FROM_DEFAULT=noreply@${KC_HOSTNAME}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
ENVEOF
chmod 600 /opt/compliance/.env.prod
echo "   wrote /opt/compliance/.env.prod (600)"

echo
echo "=== [4/6] ECR login + pull ==="
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin "$REGISTRY" || fail "ecr login failed"
docker compose -f /opt/compliance/docker-compose.prod.yml --env-file /opt/compliance/.env.prod pull || fail "docker compose pull failed"

echo
echo "=== [5/6] up -d ==="
docker compose -f /opt/compliance/docker-compose.prod.yml --env-file /opt/compliance/.env.prod up -d || fail "docker compose up failed"

echo
echo "=== [6/6] VERIFICATION (polling up to 3 min) ==="
ok=1
for i in $(seq 1 36); do
  H=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>/dev/null || echo 000)
  R=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health/ready 2>/dev/null || echo 000)
  K=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/realms/e0-test 2>/dev/null || echo 000)
  [ "$H" = "200" ] && [ "$R" = "200" ] && [ "$K" = "200" ] && break
  sleep 5
done
echo "-- /health: $H (expect 200) --"
echo "-- /health/ready: $R (expect 200) --"
echo "-- keycloak /realms/e0-test: $K (expect 200) --"
[ "$H" = "200" ] || { echo "   API /health FAILED"; ok=0; }
[ "$R" = "200" ] || { echo "   API /health/ready FAILED"; ok=0; }
[ "$K" = "200" ] || { echo "   Keycloak realm probe FAILED"; ok=0; }

echo "-- worker startup log line --"
if docker compose -f /opt/compliance/docker-compose.prod.yml logs worker 2>&1 | grep -q "Worker process started"; then
  echo "   worker: OK"
else
  echo "   worker startup log line NOT FOUND"; ok=0
fi

echo
if [ "$ok" = "1" ]; then
  echo "=== SUB-PHASE B: PASS ==="
else
  echo "=== SUB-PHASE B: FAIL -- inspect with: docker compose -f /opt/compliance/docker-compose.prod.yml logs ==="
  exit 1
fi
