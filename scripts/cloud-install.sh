#!/usr/bin/env bash
set -euo pipefail

# Idempotent Cloud Agent / local bootstrap after checkout.
if [ ! -f package.json ]; then
  echo "package.json not found; skipping install"
  exit 0
fi

# Ensure PostgreSQL 16 exists on Debian/Ubuntu-based hosts (Cloud Agent / CI).
# Guarded so local macOS/Docker workflows (no apt-get) are left untouched.
ensure_postgres() {
  if command -v pg_ctlcluster >/dev/null 2>&1 || command -v psql >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    return 0
  fi
  echo "Installing PostgreSQL (Cloud Agent bootstrap)..."
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib
}

ensure_postgres

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npx prisma generate
