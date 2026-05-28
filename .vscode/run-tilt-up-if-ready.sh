#!/usr/bin/env bash
# Used by the "Tilt: up" task on folder open — skips quietly if prerequisites are missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="/workspaces"

for repo in bng-metric-frontend bng-metric-backend; do
  if [[ ! -d "${WORKSPACE_ROOT}/${repo}" ]]; then
    echo "Skipping Tilt: ${repo} not found at ${WORKSPACE_ROOT}/${repo}."
    echo "On the host run: npm run bootstrap && npm run install:all"
    exit 0
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Skipping Tilt: docker not on PATH."
  exit 0
fi

# Keep project Docker auth isolated by default, unless caller set DOCKER_CONFIG.
if [[ -z "${DOCKER_CONFIG:-}" ]]; then
  export DOCKER_CONFIG="${HOME}/.docker-bng-metric"
fi

mkdir -p "${DOCKER_CONFIG}"
if [[ ! -f "${DOCKER_CONFIG}/config.json" ]]; then
  cat >"${DOCKER_CONFIG}/config.json" <<'JSON'
{
  "auths": {}
}
JSON
fi

if ! docker info >/dev/null 2>&1; then
  echo "Skipping Tilt: cannot reach Docker (is Docker Desktop / the engine running on the host?)."
  exit 0
fi

if ! command -v tilt >/dev/null 2>&1; then
  echo "Skipping Tilt: tilt not on PATH (rebuild the dev container)."
  exit 0
fi

cd "${REPO_ROOT}"
exec tilt up --stream
