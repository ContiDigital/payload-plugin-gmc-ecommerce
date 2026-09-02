#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_suffix="$$"
postgres_container="gmc-v2-postgres-${run_suffix}"
mongo_container="gmc-v2-mongo-${run_suffix}"

cleanup() {
  docker rm -f "$postgres_container" "$mongo_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$repo_root"

pnpm exec vitest --run dev/v2.int.spec.ts

docker run --detach --name "$postgres_container" \
  --env POSTGRES_DB=gmc_v2 \
  --env POSTGRES_PASSWORD=gmc_v2_password \
  --env POSTGRES_USER=gmc_v2 \
  --publish 127.0.0.1::5432 \
  postgres:16-alpine >/dev/null

postgres_port="$(docker port "$postgres_container" 5432/tcp | sed 's/.*://')"
for _attempt in $(seq 1 60); do
  if docker exec "$postgres_container" pg_isready --dbname gmc_v2 --username gmc_v2 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$postgres_container" pg_isready --dbname gmc_v2 --username gmc_v2 >/dev/null

GMC_V2_TEST_DATABASE=postgres \
GMC_V2_POSTGRES_URL="postgresql://gmc_v2:gmc_v2_password@127.0.0.1:${postgres_port}/gmc_v2" \
pnpm exec vitest --run dev/v2.int.spec.ts

GMC_V2_TEST_NO_TRANSACTIONS=1 \
GMC_V2_POSTGRES_URL="postgresql://gmc_v2:gmc_v2_password@127.0.0.1:${postgres_port}/gmc_v2" \
pnpm exec vitest --run dev/v2.no-transactions.int.spec.ts

docker run --detach --name "$mongo_container" \
  --publish 127.0.0.1::27017 \
  mongo:7 --replSet gmc-v2-rs --bind_ip_all >/dev/null

mongo_port="$(docker port "$mongo_container" 27017/tcp | sed 's/.*://')"
for _attempt in $(seq 1 60); do
  if docker exec "$mongo_container" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' | rg -q '^1$'; then
    break
  fi
  sleep 1
done
docker exec "$mongo_container" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' | rg -q '^1$'
docker exec "$mongo_container" mongosh --quiet --eval \
  'rs.initiate({_id:"gmc-v2-rs",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
for _attempt in $(seq 1 60); do
  if docker exec "$mongo_container" mongosh --quiet --eval 'db.hello().isWritablePrimary' | rg -q '^true$'; then
    break
  fi
  sleep 1
done
docker exec "$mongo_container" mongosh --quiet --eval 'db.hello().isWritablePrimary' | rg -q '^true$'

GMC_V2_TEST_DATABASE=mongodb \
GMC_V2_MONGODB_URL="mongodb://127.0.0.1:${mongo_port}/gmc_v2?replicaSet=gmc-v2-rs&directConnection=true" \
pnpm exec vitest --run dev/v2.int.spec.ts

echo "GMC v2 database matrix passed: SQLite, PostgreSQL (including disabled-transaction fail-closed), MongoDB."
