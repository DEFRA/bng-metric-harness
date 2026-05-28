#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="/workspaces"

echo "Dev container workspace (${WORKSPACE_ROOT}):"
ls -la "${WORKSPACE_ROOT}" 2>/dev/null || true

# Tools used by GitHub Actions workflows (e.g. pages.yml) and Tilt (docker compose)
sudo apt-get update
sudo apt-get install -y --no-install-recommends jq graphviz ripgrep

# Tilt — orchestrates Docker services + frontend/backend (see Tiltfile)
curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash

# Harness — matches Node 24 + npm ci in package.json engines
cd "${REPO_ROOT}"
npm ci

# MkDocs Material — matches Python 3.12 + pip in .github/workflows/pages.yml
pip3 install --user -r "${REPO_ROOT}/.devcontainer/requirements.txt"

# Sibling repos — cloned beside the harness (../bng-metric-frontend, ../bng-metric-backend on the host)
if [[ -d "${WORKSPACE_ROOT}/bng-metric-frontend" && -d "${WORKSPACE_ROOT}/bng-metric-backend" ]]; then
  echo "Sibling repos found — installing npm dependencies in all three..."
  npm run install:all
else
  echo ""
  echo "Sibling repos not visible under ${WORKSPACE_ROOT}."
  echo "Expected beside the harness on the host:"
  echo "  ../bng-metric-frontend"
  echo "  ../bng-metric-backend"
  echo "Reopen in container after cloning, or run inside the container:"
  echo "  npm run bootstrap && npm run install:all"
  echo ""
fi
