#!/bin/sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."

export GIT_COMMIT="$(git rev-parse --short HEAD)"
export MUTANT="${MUTANT:-}"
export MUTANT_TAG="$(printf '%s' "${MUTANT:-base}" | tr '+' '-')"
docker compose -f tools/chaos/compose.yml build chaos
docker compose -f tools/chaos/compose.yml run --rm chaos "$@"
