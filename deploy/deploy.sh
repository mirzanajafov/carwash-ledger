#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f docker-compose.prod.yml)
branch="${DEPLOY_BRANCH:-main}"
force=false
[ "${1:-}" = "--force" ] && force=true

say() { printf '\n== %s\n' "$1"; }

healthy() {
  say "Waiting for the API, the worker and the web app"
  for _ in $(seq 1 60); do
    api=$(docker inspect -f '{{.State.Health.Status}}' carwash-api 2>/dev/null || true)
    worker=$(docker inspect -f '{{.State.Health.Status}}' carwash-worker 2>/dev/null || true)
    web=$(docker inspect -f '{{.State.Health.Status}}' carwash-web 2>/dev/null || true)
    if [ "$api" = healthy ] && [ "$worker" = healthy ] && [ "$web" = healthy ]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

release() {
  say "Building the images and starting the stack"
  "${compose[@]}" build -q && "${compose[@]}" up -d --remove-orphans
}

previous=$(git rev-parse HEAD)
git fetch --quiet origin "$branch"
target=$(git rev-parse "origin/$branch")

if [ "$previous" = "$target" ] && [ "$force" = false ]; then
  echo "Already at $(git log --oneline -1). Use --force to rebuild anyway."
  exit 0
fi

if docker inspect carwash-postgres > /dev/null 2>&1; then
  say "Backing up before the deploy"
  "${compose[@]}" run --rm backup once
fi

say "Deploying $(git log --oneline -1 "$target")"
git merge --ff-only --quiet "$target"
if release && healthy; then
  docker image prune -f --filter label=app=carwash > /dev/null
  say "Live: $(git log --oneline -1)"
  exit 0
fi

say "Not live, rolling back to $(git log --oneline -1 "$previous")"
git reset --hard --quiet "$previous"
if release && healthy; then
  echo "Rolled back. Database migrations from the failed release stay applied,"
  echo "and the dump taken above is in backups/db if the schema change has to be undone."
else
  echo "Rollback is not healthy either. Check: ${compose[*]} logs api worker web" >&2
fi
exit 1
