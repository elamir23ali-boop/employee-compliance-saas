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

# SSM Session Manager logs sessions in as `ssm-user`, never `ec2-user` or
# root (AWS default for AL2023) -- and ssm-user is NOT in the `docker`
# group (bootstrap.sh only adds ec2-user), nor can it write /opt. Rather
# than depend on the operator remembering `sudo bash deploy-stack.sh`
# every time (get it wrong once and you get a half-written /opt/compliance
# from a previous non-root attempt, then a *different*, confusing failure
# on the retry under sudo -- exactly what happened here), the script
# elevates itself unconditionally so its execution context is always the
# same regardless of how it was invoked.
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

export AWS_DEFAULT_REGION=eu-west-1
REGISTRY="218201720464.dkr.ecr.eu-west-1.amazonaws.com"
TAG="db27752"
REPO_RAW="https://raw.githubusercontent.com/elamir23ali-boop/employee-compliance-saas/e7/aws-deployment"
COMPOSE_SHA256="782a1d1f341b97029b8ed0ef255b2d7c604ac896671eb8af26258d9d27b57afc"
REALM_SHA256="090ee72359bf0af36edea968d93e0e3aa9c25d1f4cbb9591caea6f0077ac2455"

fail(){ echo; echo "FATAL: $*" >&2; exit 1; }
verify(){ # verify <file> <expected-sha256>
  local f=$1 exp=$2 got
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$got" = "$exp" ] || fail "$f checksum mismatch: got $got, expected $exp -- fetch corrupted or file changed upstream, do not proceed"
}
command -v jq >/dev/null || dnf install -y -q jq

echo "=== [1/7] ensure docker compose plugin is present ==="
# Not "run fix-compose-plugin.sh first, then re-run this script" anymore --
# an SSM send-command invocation is one-shot and non-interactive, so a
# script that just fails and points at a second script left the operator
# doing a manual round trip every time this needed repairing (confirmed
# recurring, 2026-09-14). Installs the exact same v2.32.4 static binary
# bootstrap.sh puts at first boot, to the same system-wide path (not a
# per-user ~/.docker/cli-plugins -- that would only be visible to
# whichever user installed it, and this script always runs as root via
# the self-elevation above) -- idempotent, safe to run every time
# regardless of whether the plugin actually needs reinstalling.
COMPOSE_PLUGIN_VERSION="v2.32.4"
COMPOSE_PLUGIN_PATH="/usr/libexec/docker/cli-plugins/docker-compose"
if ! docker compose version >/dev/null 2>&1; then
  echo "   docker compose not working -- (re)installing the plugin"
  mkdir -p "$(dirname "$COMPOSE_PLUGIN_PATH")" || fail "mkdir $(dirname "$COMPOSE_PLUGIN_PATH") failed"
  curl -fsSL -o "$COMPOSE_PLUGIN_PATH" \
    "https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-x86_64" \
    || fail "docker compose plugin download failed"
  chmod +x "$COMPOSE_PLUGIN_PATH"
  docker compose version >/dev/null 2>&1 \
    || fail "docker compose still not working after reinstalling $COMPOSE_PLUGIN_PATH -- something deeper is wrong (docker itself broken? wrong arch?); diagnose manually with: docker version; file $COMPOSE_PLUGIN_PATH"
  echo "   installed to $COMPOSE_PLUGIN_PATH"
else
  echo "   already present"
fi

mkdir -p /opt/compliance/keycloak || fail "mkdir /opt/compliance/keycloak failed"

echo "=== [2/7] fetch compose file + realm export from GitHub ==="
curl -fsSL "$REPO_RAW/infra/aws/docker-compose.prod.yml" -o /opt/compliance/docker-compose.prod.yml || fail "curl docker-compose.prod.yml failed"
curl -fsSL "$REPO_RAW/infra/docker/keycloak/realm-export.json" -o /opt/compliance/keycloak/realm-export.json || fail "curl realm-export.json failed"
verify /opt/compliance/docker-compose.prod.yml "$COMPOSE_SHA256"
verify /opt/compliance/keycloak/realm-export.json "$REALM_SHA256"
echo "   fetched + verified both files"

echo
echo "=== [3/7] fetch secrets (instance role) ==="
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

# compliance/prod/keycloak's KC_HOSTNAME is stored as a full URL
# (https://compliance.ai-english-os.online/auth) -- Keycloak's own v2
# hostname provider (docker-compose.prod.yml's KC_HOSTNAME env, passed
# through unmodified) accepts and correctly uses that as-is, and real
# issued tokens' `iss` claim confirm it: `.../auth/realms/e0-test`.
# KEYCLOAK_ISSUER/JWKS_URI below must reuse it verbatim, NOT prepend
# another `https://` (that produced `https://https://...`, an unparseable
# URL -- the API's JWKS fetch failed outright and every real request
# 401'd; confirmed live 2026-09-18 via E7 Phase 4's smoke test, the first
# time any script actually exercised a real authenticated request against
# this deployment). SMTP_FROM_DEFAULT needs a bare domain, not a full URL
# with a path, so it strips the scheme/path separately.
KC_BARE_HOST=$(echo "$KC_HOSTNAME" | sed -E 's#^https?://##; s#/.*##')
[ -n "$KC_BARE_HOST" ] || fail "could not derive a bare hostname from KC_HOSTNAME=$KC_HOSTNAME"
echo "   db host: $DB_HOST  |  kc host: $KC_HOSTNAME  |  node_env: $NODE_ENV"

echo
echo "=== [4/7] render .env.prod ==="
# DB_NAME deliberately hardcoded to e0db, NOT read from the DB_NAME key in
# compliance/prod/database -- the RDS instance itself was created with
# --db-name compliance_db (ADR-041's own recorded deviation), and e0db is
# the database rds-bootstrap.sh actually created and migrated. Trusting an
# unread secret field here risks silently pointing prod at the empty,
# unmigrated compliance_db.
#
# ?sslmode=no-verify -- default.postgres18 has rds.force_ssl=1 (confirmed
# live via describe-db-parameters), so RDS rejects a plain-TCP startup
# packet outright; TLS is mandatory. NOT ?sslmode=require: this repo's
# pg-connection-string version (bundled with the `pg` driver apps/api
# and apps/worker already use) only special-cases traditional libpq
# "encrypt but don't verify" semantics under `no-verify` -- `require`
# here just turns TLS on and leaves the ssl object's rejectUnauthorized
# at Node's default (true), so it still does full chain validation.
# Confirmed live: `require` produced `ERR code=SELF_SIGNED_CERT_IN_CHAIN`
# from `new Pool({connectionString}).query('SELECT 1')` run inside the
# api container itself -- Node's default trust store doesn't carry
# AWS's RDS CA chain. `no-verify` sets `ssl.rejectUnauthorized = false`,
# encrypting without validating the cert -- acceptable here because the
# path stays inside the VPC between compliance-app-sg and
# compliance-rds-sg, never the public internet. No application code
# change or image rebuild needed either way, since DrizzleService/
# apps/worker's main.ts just hand process.env.DATABASE_URL straight to
# `new Pool({connectionString})`. Full chain validation (`verify-full`
# + the RDS CA bundle baked into the api/worker images) is a real
# hardening gap, not implemented in this fix -- it needs a Dockerfile
# change + image rebuild, out of scope for restoring connectivity.
cat > /opt/compliance/.env.prod <<ENVEOF
ECR_REGISTRY=${REGISTRY}
IMAGE_TAG=${TAG}
NODE_ENV=${NODE_ENV}
PORT=${PORT}
DB_HOST=${DB_HOST}
DATABASE_URL=postgresql://${DB_APP_USER}:${DB_APP_PASSWORD}@${DB_HOST}:5432/e0db?sslmode=no-verify
DATABASE_MIGRATION_URL=postgresql://${DB_MIGRATION_USER}:${DB_MIGRATION_PASSWORD}@${DB_HOST}:5432/e0db?sslmode=no-verify
REDIS_PASSWORD=${REDIS_PASSWORD}
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/1
KC_HOSTNAME=${KC_HOSTNAME}
KC_DB_PASSWORD=${KC_DB_PASSWORD}
KC_ADMIN_PASSWORD=${KC_ADMIN_PASSWORD}
KEYCLOAK_ISSUER=${KC_HOSTNAME}/realms/e0-test
# Internal address, NOT KC_HOSTNAME -- decoupled from KEYCLOAK_ISSUER
# (jwt.strategy.ts fetches this URL directly; ISSUER is only ever
# string-compared against the `iss` claim). nginx.conf doesn't route
# /auth/realms/* to keycloak (only bare /realms), so KC_HOSTNAME's
# advertised /auth URL 502'd here -- confirmed live 2026-09-18.
KEYCLOAK_JWKS_URI=http://keycloak:8080/realms/e0-test/protocol/openid-connect/certs
KEYCLOAK_CLIENT_ID=e0-api
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
# Not in compliance/prod/smtp (only HOST/PORT/USER/PASS are secret) --
# these two are non-secret provider config, defaulted here rather than
# invented as new Secrets Manager fields.
SMTP_SECURE=true
SMTP_FROM_DEFAULT=noreply@${KC_BARE_HOST}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
ENVEOF
chmod 600 /opt/compliance/.env.prod
echo "   wrote /opt/compliance/.env.prod (600)"

echo
echo "=== [5/7] ECR login + pull ==="
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin "$REGISTRY" || fail "ecr login failed"
# Scoped to the 4 services this script owns -- since Sub-phase C, the
# compose file also carries `nginx`, whose bind mount
# (/opt/compliance/nginx.conf) doesn't exist until infra/aws/setup-tls.sh
# creates it. A bare `pull`/`up -d` (no service args) would include it
# and fail on that missing file -- confirmed 2026-09-14. setup-tls.sh
# manages nginx's lifecycle exclusively; this script never touches it.
STACK_SERVICES="redis keycloak api worker"
docker compose -f /opt/compliance/docker-compose.prod.yml --env-file /opt/compliance/.env.prod pull $STACK_SERVICES || fail "docker compose pull failed"

echo
echo "=== [6/7] up -d ==="
docker compose -f /opt/compliance/docker-compose.prod.yml --env-file /opt/compliance/.env.prod up -d $STACK_SERVICES || fail "docker compose up failed"

echo
echo "=== [7/7] VERIFICATION (polling up to 3 min) ==="
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

echo "-- api's own KEYCLOAK_JWKS_URI (config sanity, not just reachability) --"
# The 3 checks above never exercised the API's actual rendered
# KEYCLOAK_ISSUER/JWKS_URI config -- a malformed value there (confirmed
# live 2026-09-18: a doubled "https://https://..." from an earlier
# version of this script) still passed all three, and only surfaced when
# E7 Phase 4's smoke test made a real authenticated request. This reuses
# the exact URL apps/api itself was just given, from inside the container
# (not the host), so a hostname-resolution difference between the two
# can't hide a break.
J=$(docker compose -f /opt/compliance/docker-compose.prod.yml --env-file /opt/compliance/.env.prod exec -T api \
  node -e "fetch(process.env.KEYCLOAK_JWKS_URI).then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('000'))" 2>/dev/null || echo 000)
echo "-- api's KEYCLOAK_JWKS_URI fetch: $J (expect 200) --"
[ "$J" = "200" ] || { echo "   KEYCLOAK_JWKS_URI FAILED -- check KC_HOSTNAME in compliance/prod/keycloak"; ok=0; }

echo "-- worker startup log line --"
# Retried, not one-shot: the HTTP checks above can already be 200 (e.g.
# keycloak/api were healthy before this run touched them) and break the
# outer loop with zero sleep, while `up -d` restarted worker concurrently
# -- a fresh process needs a few seconds to boot and print this line.
# Confirmed race 2026-09-18: a one-shot grep run immediately after `up -d`
# reported NOT FOUND, but the line appeared in `docker compose logs`
# seconds later on manual inspection.
worker_ok=0
for i in $(seq 1 12); do
  docker compose -f /opt/compliance/docker-compose.prod.yml logs worker 2>&1 | grep -q "Worker process started" && { worker_ok=1; break; }
  sleep 5
done
if [ "$worker_ok" = "1" ]; then
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
