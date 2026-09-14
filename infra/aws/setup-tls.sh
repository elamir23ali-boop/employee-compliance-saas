#!/bin/bash
# E7 Phase 3 Sub-phase C -- Nginx + Let's Encrypt TLS, run ONCE on the EC2
# host (SSM session), after Sub-phase B (infra/aws/deploy-stack.sh) has
# already passed. DNS (compliance.ai-english-os.online -> the Elastic IP)
# and compliance-app-sg's 80/443-from-0.0.0.0/0 rule both predate this
# script (Phase 1/2) -- nothing to do on either front here.
#
# Usage: bash setup-tls.sh <letsencrypt-contact-email>
#
# What it does:
#   - re-fetches docker-compose.prod.yml (now carrying the `nginx`
#     service) + both nginx configs from GitHub, sha256-verified, same
#     pattern as deploy-stack.sh
#   - starts ONLY the `nginx` service (api/keycloak/worker/redis are
#     already running from Sub-phase B, untouched) with the bootstrap
#     config -- ACME challenge only, no TLS yet
#   - issues the real cert via the `certbot/certbot` image (webroot
#     challenge against the bootstrap Nginx), no certbot package install
#     on the host
#   - swaps in the real nginx.conf (TLS + proxying) and restarts nginx
#   - polls https://<domain>/health and the Keycloak realm probe through
#     the proxy, prints PASS/FAIL
#   - installs a daily cron job (infra/aws/renew-cert.sh, rendered here)
#     so renewal needs no manual step -- `certbot renew` is a no-op
#     outside its ~30-day-before-expiry window, so daily is the standard,
#     not wasteful, cadence
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

LE_EMAIL="${1:-}"
DOMAIN="compliance.ai-english-os.online"

fail(){ echo; echo "FATAL: $*" >&2; exit 1; }

[ -n "$LE_EMAIL" ] || fail "usage: bash setup-tls.sh <letsencrypt-contact-email> -- certbot requires a real contact address for expiry notices, not guessed here"

REPO_RAW="https://raw.githubusercontent.com/elamir23ali-boop/employee-compliance-saas/e7/aws-deployment"
COMPOSE_SHA256="782a1d1f341b97029b8ed0ef255b2d7c604ac896671eb8af26258d9d27b57afc"
NGINX_BOOTSTRAP_SHA256="cf0cd0b9a16b1dcc2a327324d95eef3d5169f66b1452df23877479b443d83537"
NGINX_FINAL_SHA256="d88795faaccdfa189c184d413b953e7965b43390594c38d5ff1d5403c4c722ac"

verify(){ # verify <file> <expected-sha256>
  local f=$1 exp=$2 got
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$got" = "$exp" ] || fail "$f checksum mismatch: got $got, expected $exp -- fetch corrupted or file changed upstream, do not proceed"
}

COMPOSE="/opt/compliance/docker-compose.prod.yml"
ENVFILE="/opt/compliance/.env.prod"
[ -f "$ENVFILE" ] || fail "$ENVFILE not found -- run deploy-stack.sh (Sub-phase B) first"

# Same self-heal as deploy-stack.sh's [1/7] (2026-09-14: confirmed
# recurring on this host, needed a manual fix-compose-plugin.sh round
# trip once already) -- reinstall the plugin here too rather than
# depending on a still-working state left over from a prior script run.
COMPOSE_PLUGIN_VERSION="v2.32.4"
COMPOSE_PLUGIN_PATH="/usr/libexec/docker/cli-plugins/docker-compose"
if ! docker compose version >/dev/null 2>&1; then
  mkdir -p "$(dirname "$COMPOSE_PLUGIN_PATH")" || fail "mkdir $(dirname "$COMPOSE_PLUGIN_PATH") failed"
  curl -fsSL -o "$COMPOSE_PLUGIN_PATH" \
    "https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-x86_64" \
    || fail "docker compose plugin download failed"
  chmod +x "$COMPOSE_PLUGIN_PATH"
  docker compose version >/dev/null 2>&1 \
    || fail "docker compose still not working after reinstalling $COMPOSE_PLUGIN_PATH -- diagnose manually: docker version; file $COMPOSE_PLUGIN_PATH"
fi

echo "=== [1/7] fetch updated compose file + both nginx configs ==="
curl -fsSL "$REPO_RAW/infra/aws/docker-compose.prod.yml" -o "$COMPOSE" || fail "curl docker-compose.prod.yml failed"
curl -fsSL "$REPO_RAW/infra/aws/nginx/nginx.bootstrap.conf" -o /opt/compliance/nginx.bootstrap.conf || fail "curl nginx.bootstrap.conf failed"
curl -fsSL "$REPO_RAW/infra/aws/nginx/nginx.conf" -o /opt/compliance/nginx.conf.final || fail "curl nginx.conf failed"
verify "$COMPOSE" "$COMPOSE_SHA256"
verify /opt/compliance/nginx.bootstrap.conf "$NGINX_BOOTSTRAP_SHA256"
verify /opt/compliance/nginx.conf.final "$NGINX_FINAL_SHA256"
echo "   fetched + verified all three"

echo
echo "=== [2/7] bring up nginx with the bootstrap (no-TLS) config ==="
mkdir -p /opt/compliance/certbot-webroot || fail "mkdir certbot-webroot failed"
# Explicit, not left to Docker to auto-create on first bind-mount: recent
# Docker Engine versions (this host: 29.x-class) no longer reliably
# create a missing bind-mount source directory implicitly.
mkdir -p /etc/letsencrypt || fail "mkdir /etc/letsencrypt failed"
cp /opt/compliance/nginx.bootstrap.conf /opt/compliance/nginx.conf || fail "cp bootstrap conf failed"
docker compose -f "$COMPOSE" --env-file "$ENVFILE" up -d nginx || fail "docker compose up nginx (bootstrap) failed"

ok=0
for i in $(seq 1 12); do
  # The bootstrap config's `location / { return 503; }` is a precise
  # signal that it (not e.g. the nginx:alpine image's own default
  # welcome-page config, which answers 200) is actually loaded.
  C=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost/" 2>/dev/null || echo 000)
  [ "$C" = "503" ] && { ok=1; break; }
  sleep 5
done
[ "$ok" = "1" ] || fail "bootstrap nginx never came up with the expected config (last code: $C, expected 503) -- check: docker compose -f $COMPOSE logs nginx"
echo "   bootstrap nginx answering on :80 with the expected config"

echo
echo "=== [3/7] issue the certificate (certbot, HTTP-01 webroot challenge) ==="
docker run --rm \
  -v /opt/compliance/certbot-webroot:/var/www/certbot \
  -v /etc/letsencrypt:/etc/letsencrypt \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$LE_EMAIL" --agree-tos --non-interactive --no-eff-email \
  || fail "certbot certonly failed -- common causes: DNS not resolving to this host yet, port 80 blocked, or Let's Encrypt rate limit; check: docker compose -f $COMPOSE logs nginx"
echo "   certificate issued: /etc/letsencrypt/live/$DOMAIN/"

echo
echo "=== [4/7] swap in the real (TLS) config and restart nginx ==="
cp /opt/compliance/nginx.conf.final /opt/compliance/nginx.conf || fail "cp final conf failed"
docker compose -f "$COMPOSE" --env-file "$ENVFILE" restart nginx || fail "docker compose restart nginx failed"

echo
echo "=== [5/7] VERIFICATION (polling up to 2 min) ==="
ok=1
for i in $(seq 1 24); do
  H=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/health" 2>/dev/null || echo 000)
  K=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/realms/e0-test" 2>/dev/null || echo 000)
  [ "$H" = "200" ] && [ "$K" = "200" ] && break
  sleep 5
done
echo "-- https://$DOMAIN/health: $H (expect 200) --"
echo "-- https://$DOMAIN/realms/e0-test: $K (expect 200) --"
[ "$H" = "200" ] || { echo "   https /health FAILED"; ok=0; }
[ "$K" = "200" ] || { echo "   https keycloak realm probe FAILED"; ok=0; }

echo
echo "=== [6/7] install the renewal cron job ==="
if dnf install -y -q cronie && systemctl enable --now crond; then
  echo "   cronie installed + crond running"
else
  # Not fatal -- the cert issued in [3/7]/[4/7] is already valid for 90
  # days regardless; only auto-renewal is at risk. Surfaced loudly rather
  # than swallowed so it doesn't get silently discovered at day 89.
  echo "   WARNING: cronie install/enable failed -- renewal will NOT run automatically. Investigate manually: dnf install cronie; systemctl enable --now crond" >&2
fi
cat > /opt/compliance/renew-cert.sh <<'RENEWEOF'
#!/bin/bash
# Installed by infra/aws/setup-tls.sh. `certbot renew` is a no-op outside
# its ~30-day-before-expiry window, so running this daily costs nothing on
# the other ~335 days. Reload (not full restart) so an in-flight request
# through nginx is never dropped for this.
set -uo pipefail
docker run --rm \
  -v /opt/compliance/certbot-webroot:/var/www/certbot \
  -v /etc/letsencrypt:/etc/letsencrypt \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet
docker compose -f /opt/compliance/docker-compose.prod.yml exec -T nginx nginx -s reload
RENEWEOF
chmod 700 /opt/compliance/renew-cert.sh
( crontab -l 2>/dev/null | grep -v renew-cert.sh; echo "17 3 * * * /opt/compliance/renew-cert.sh >> /var/log/compliance-certbot-renew.log 2>&1" ) | crontab -
echo "   renew-cert.sh installed, cron: daily 03:17"

echo
echo "=== [7/7] result ==="
if [ "$ok" = "1" ]; then
  echo "=== SUB-PHASE C: PASS ==="
else
  echo "=== SUB-PHASE C: FAIL -- inspect with: docker compose -f $COMPOSE logs nginx ==="
  exit 1
fi
