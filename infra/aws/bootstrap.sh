#!/bin/bash
# EC2 user-data -- host bootstrap for the compliance SaaS app instance.
# Target: Amazon Linux 2023, t2.micro (1 vCPU / 1 GiB). See ADR-038.
# Scope: host prep only (Docker + Compose plugin + swap). The application
# stack (apps/api, apps/worker, Redis, Keycloak, Nginx) is deployed in a
# later E7 phase, not here.
set -euo pipefail
exec > >(tee /var/log/bootstrap.log) 2>&1
echo "bootstrap start: $(date -u +%FT%TZ)"

# --- 2 GB swapfile -------------------------------------------------------
# 1 GiB RAM is tight for Keycloak's JVM + two Node procs + Redis (ADR-038).
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

# --- base packages -----------------------------------------------------
dnf -y update
dnf -y install docker

# --- Docker -----------------------------------------------------------
systemctl enable --now docker
usermod -aG docker ec2-user

# --- Compose v2 plugin ----------------------------------------------
# Not in the AL2023 default repos; install the static plugin binary.
COMPOSE_VERSION="v2.32.4"
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
chmod +x /usr/libexec/docker/cli-plugins/docker-compose
docker compose version

echo "bootstrap done: $(date -u +%FT%TZ)"
