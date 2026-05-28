#!/usr/bin/env bash
# Used by the "MkDocs: serve" task on folder open — skips quietly if Node is missing.
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Skipping MkDocs serve: Node.js/npm not found on PATH."
  echo "Use Dev Containers: Reopen in Container, or install Node 24 locally."
  exit 0
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npm run docs:serve
