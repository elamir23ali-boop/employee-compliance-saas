#!/bin/bash
# E7 Phase 3 -- single entrypoint for the whole app stack: Sub-phase B
# (infra/aws/deploy-stack.sh: redis/keycloak/api/worker) then, only if
# that passes, Sub-phase C (infra/aws/setup-tls.sh: nginx + TLS). One SSM
# send-command instead of two separate round trips -- both underlying
# scripts stay independently runnable (e.g. re-running just deploy-stack.sh
# alone to roll out a new app image tag later needs no TLS/cert work
# repeated), this is purely a convenience wrapper, no logic duplicated.
#
# Usage: bash deploy-full.sh <letsencrypt-contact-email>
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

LE_EMAIL="${1:-}"
[ -n "$LE_EMAIL" ] || { echo "FATAL: usage: bash deploy-full.sh <letsencrypt-contact-email>" >&2; exit 1; }

REPO_RAW="https://raw.githubusercontent.com/elamir23ali-boop/employee-compliance-saas/e7/aws-deployment"

echo "############################################"
echo "### Sub-phase B: deploy-stack.sh"
echo "############################################"
curl -fsSL "$REPO_RAW/infra/aws/deploy-stack.sh" -o /tmp/deploy-stack.sh || { echo "FATAL: curl deploy-stack.sh failed" >&2; exit 1; }
bash /tmp/deploy-stack.sh
rc=$?
if [ "$rc" -ne 0 ]; then
  echo
  echo "FATAL: deploy-stack.sh failed (exit $rc) -- not proceeding to Sub-phase C. Re-check StandardErrorContent, not just StandardOutputContent, if this was run via ssm send-command." >&2
  exit "$rc"
fi

echo
echo "############################################"
echo "### Sub-phase C: setup-tls.sh"
echo "############################################"
curl -fsSL "$REPO_RAW/infra/aws/setup-tls.sh" -o /tmp/setup-tls.sh || { echo "FATAL: curl setup-tls.sh failed" >&2; exit 1; }
bash /tmp/setup-tls.sh "$LE_EMAIL"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FATAL: setup-tls.sh failed (exit $rc)" >&2
  exit "$rc"
fi

echo
echo "=== deploy-full.sh: Sub-phase B + C both PASS ==="
