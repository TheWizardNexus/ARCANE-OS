#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/dist/linux/ArcaneShell"
[[ -x "$APP" ]] || { echo 'ArcaneShell has not been built. Run npm run build:distribution:linux:unsigned-local-test first.' >&2; exit 2; }
exec "$APP" "$@"
