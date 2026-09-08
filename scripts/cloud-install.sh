#!/usr/bin/env bash
set -euo pipefail

# Idempotent Cloud Agent / local bootstrap after checkout.
if [ ! -f package.json ]; then
  echo "package.json not found; skipping install"
  exit 0
fi

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npx prisma generate
