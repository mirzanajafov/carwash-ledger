#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ledger=$(ls -1t backups/db/ledger-*.dump | head -1)
witness=$(ls -1t backups/witness/witness-*.tar.gz | head -1)
name=carwash-restore-check
work=$(mktemp -d)
trap 'docker rm -f "$name-db" "$name-witness" > /dev/null 2>&1 || true; docker network rm "$name" > /dev/null 2>&1 || true; rm -rf "$work"' EXIT

echo "== Restoring $ledger and $witness into a throwaway Postgres"
docker network create "$name" > /dev/null
docker run -d --name "$name-db" --network "$name" -e POSTGRES_PASSWORD=check postgres:18-alpine > /dev/null
for _ in $(seq 1 60); do docker exec "$name-db" pg_isready -U postgres > /dev/null 2>&1 && break; sleep 1; done
docker exec "$name-db" createdb -U postgres ledger
docker exec -i "$name-db" pg_restore -U postgres --no-owner --no-privileges -d ledger < "$ledger"

tar -xzf "$witness" -C "$work"
docker run -d --name "$name-witness" --network "$name" --user "$(id -u):$(id -g)" -v "$(cygpath -m "$work" 2>/dev/null || echo "$work"):/var/lib/witness" \
  -e WITNESS_TOKEN=restore-check -e WITNESS_DIR=/var/lib/witness carwash-server:latest node apps/witness/dist/main.js > /dev/null
sleep 2

run() {
  docker run --rm --network "$name" -e DATABASE_URL=postgresql://postgres:check@$name-db:5432/ledger -e WITNESS_URL=http://$name-witness:3145 \
    carwash-server:latest node "$@"
}

echo "== The invariants on the restored ledger"
run apps/api/dist/cli/check.js
echo "== The audit log against the witness's signed roots"
run apps/api/dist/cli/verify.js --full
echo "== The restore checks out"
