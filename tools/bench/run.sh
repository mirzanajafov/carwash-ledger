#!/bin/sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."

compose() {
  docker compose -f docker-compose.yml -f tools/bench/compose.yml --profile bench "$@"
}

throttled() {
  docker exec carwash-postgres sh -c 'grep nr_throttled /sys/fs/cgroup/cpu.stat | cut -d" " -f2'
}

export GIT_COMMIT="$(git rev-parse --short HEAD)"
compose up -d --wait postgres
export PG_CGROUP="$(docker exec carwash-postgres sh -c 'echo "cpu.max=$(cat /sys/fs/cgroup/cpu.max) cpuset=$(cat /sys/fs/cgroup/cpuset.cpus.effective) memory.max=$(cat /sys/fs/cgroup/memory.max)"')"
echo "postgres: $PG_CGROUP"
before="$(throttled)"
compose build bench
if [ "${BENCH_DETACH:-0}" = "1" ]; then
  compose run -d --rm --name carwash-bench bench "$@"
  echo "postgres throttled periods before the run: $before"
  exit 0
fi
compose run --rm bench "$@"
after="$(throttled)"
echo "postgres throttled periods during the run: $((after - before))"
