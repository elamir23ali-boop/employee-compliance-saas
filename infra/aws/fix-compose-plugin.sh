#!/bin/bash
# E7 Phase 3 Sub-phase B -- diagnose + repair a broken `docker compose`
# CLI plugin on the compliance-app EC2 host. Run ON THE EC2 HOST (SSM
# session) if deploy-stack.sh's step [4/6] fails with something like
# "unknown shorthand flag: -f" -- the classic symptom of `docker compose`
# not being resolved as a CLI plugin at all (docker's argument parser
# falls through and chokes on the remaining flags).
#
# infra/aws/bootstrap.sh (EC2 user-data, Phase 2) already installs this
# exact plugin the same way, and it verified clean in the original boot
# console output. This script assumes something regressed since then
# rather than assuming bootstrap.sh's method was wrong -- it diagnoses
# first, only reinstalls if `docker compose version` is actually broken,
# then re-verifies. Self-diagnosing, not assumed-good, same as
# rds-bootstrap.sh / deploy-stack.sh.
set -uo pipefail
COMPOSE_VERSION="v2.32.4"
PLUGIN_PATH="/usr/libexec/docker/cli-plugins/docker-compose"

echo "=== [1/4] diagnostics ==="
echo "-- docker --version --"
docker --version 2>&1
echo "-- docker version (client Plugins section) --"
docker version 2>&1
echo "-- docker compose version (may fail -- that's what we're diagnosing) --"
docker compose version 2>&1
echo "-- ls -la \$(dirname $PLUGIN_PATH) --"
ls -la "$(dirname "$PLUGIN_PATH")" 2>&1
echo "-- file on the plugin binary (valid ELF? right arch?) --"
file "$PLUGIN_PATH" 2>&1
echo "-- docker CLI plugin search dirs docker actually reports --"
docker info --format '{{json .ClientInfo}}' 2>&1 || docker info 2>&1 | grep -iA3 plugin

echo
if docker compose version >/dev/null 2>&1; then
  echo "=== [2/4] docker compose already works -- no repair needed ==="
  echo "If deploy-stack.sh still failed, the issue is elsewhere (re-run it and capture the exact new error)."
  exit 0
fi

echo "=== [2/4] docker compose is broken -- reinstalling the v${COMPOSE_VERSION} static plugin ==="
mkdir -p "$(dirname "$PLUGIN_PATH")"
curl -fsSL -o "$PLUGIN_PATH" \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  || { echo "FATAL: download failed" >&2; exit 1; }
chmod +x "$PLUGIN_PATH"
echo "   reinstalled to $PLUGIN_PATH"

echo
echo "=== [3/4] re-verify ==="
if docker compose version 2>&1; then
  echo "   docker compose: OK"
else
  echo "FATAL: docker compose still broken after reinstall -- paste this full output back, do not guess further" >&2
  exit 1
fi

echo
echo "=== [4/4] DONE -- re-run: sudo bash /tmp/deploy-stack.sh 2>&1 | tee /tmp/deploy-stack.log ==="
