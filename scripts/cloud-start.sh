#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${POSTGRES_DB:-desertica}"
DB_USER="${POSTGRES_USER:-desertica}"
DB_PASSWORD="${POSTGRES_PASSWORD:-desertica}"

start_postgres() {
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    return 0
  fi

  if command -v pg_ctlcluster >/dev/null 2>&1; then
    sudo pg_ctlcluster 16 main start || true
  elif command -v service >/dev/null 2>&1; then
    sudo service postgresql start || true
  fi

  for _ in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "PostgreSQL did not become ready on 127.0.0.1:5432" >&2
  exit 1
}

ensure_database() {
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found; skipping database bootstrap"
    return 0
  fi

  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}' CREATEDB;
  ELSE
    ALTER ROLE ${DB_USER} WITH CREATEDB;
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
SQL
}

start_postgres
ensure_database

export DATABASE_URL="${DATABASE_URL:-postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}?schema=public}"

if [ -f prisma/schema.prisma ]; then
  npx prisma migrate deploy
fi

if curl -sf "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1; then
  echo "NestJS already listening on :${PORT:-3000}"
  exit 0
fi

if [ ! -f package.json ]; then
  echo "package.json not found; skipping API start"
  exit 0
fi

nohup npm run start:dev >/tmp/desertica-api.log 2>&1 &

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1; then
    echo "NestJS is ready on :${PORT:-3000}"
    exit 0
  fi
  sleep 1
done

echo "NestJS did not become ready; see /tmp/desertica-api.log" >&2
tail -n 80 /tmp/desertica-api.log >&2 || true
exit 1
