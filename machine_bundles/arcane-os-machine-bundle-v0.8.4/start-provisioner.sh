#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/dist/ArcaneProvisioner"
[[ -x "$APP" ]] || { echo 'ArcaneProvisioner has not been built. Run ./build-linux.sh first.' >&2; exit 2; }
exec "$APP" "$@"
