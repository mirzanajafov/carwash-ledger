#!/bin/sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."

BENCH_KAFKA=1 BENCH_DETACH=1 sh tools/bench/run.sh src/e4.ts --mode outage "$@"
docker logs -f carwash-bench 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    *"E4 OUTAGE kill kafka now"*)
      docker kill carwash-kafka > /dev/null
      echo "e4-outage: killed kafka at $(date -u +%H:%M:%S)"
      sleep "${KAFKA_DOWN_SECONDS:-30}"
      docker start carwash-kafka > /dev/null
      echo "e4-outage: started kafka at $(date -u +%H:%M:%S)"
      ;;
  esac
done
