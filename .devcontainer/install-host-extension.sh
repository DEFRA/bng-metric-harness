#!/usr/bin/env bash
# Install the Microsoft Dev Containers extension on the host.
# Use VS Code — Cursor aliases this ID to anysphere.remote-containers and cannot
# install the official Microsoft extension.
set -euo pipefail

EXTENSION="ms-vscode-remote.remote-containers"

if command -v code >/dev/null 2>&1; then
  echo "Installing Microsoft Dev Containers in VS Code (${EXTENSION})..."
  code --install-extension "${EXTENSION}"
  echo "Done. Open this folder in VS Code, then: Dev Containers: Reopen in Container"
  exit 0
fi

if command -v cursor >/dev/null 2>&1; then
  echo "Warning: Cursor replaces ${EXTENSION} with anysphere.remote-containers."
  echo "The official Microsoft Dev Containers extension is not available in Cursor."
  echo ""
  echo "To use Microsoft Dev Containers:"
  echo "  1. Install VS Code: https://code.visualstudio.com/"
  echo "  2. Run: code --install-extension ${EXTENSION}"
  echo "  3. Open this repository in VS Code (not Cursor)"
  exit 1
fi

echo "Install VS Code, then run:"
echo "  code --install-extension ${EXTENSION}"
exit 1
