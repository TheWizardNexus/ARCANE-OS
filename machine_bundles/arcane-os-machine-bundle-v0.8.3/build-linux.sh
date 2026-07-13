#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
echo '=== Building Arcane OS 0.8.3 for Linux WebKitGTK ==='
npm ci
npm run build:linux
echo "Build complete. Start with $ROOT/start-provisioner.sh"
