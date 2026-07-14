#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/dist/ArcaneShell"
[[ -x "$APP" ]] || { echo 'ArcaneShell has not been built. Run ./build-linux.sh first.' >&2; exit 2; }
exec "$APP" "$@"
