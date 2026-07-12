#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
SOURCE="$ROOT/src/hosts/linux/arcane_host.c"
mkdir -p "$DIST"

for package in gtk4 webkitgtk-6.0; do
  if ! pkg-config --exists "$package"; then
    echo "Missing Linux build dependency: $package" >&2
    echo "Debian/Ubuntu example: sudo apt install build-essential libgtk-4-dev libwebkitgtk-6.0-dev" >&2
    exit 2
  fi
done
if [[ ! -x "$DIST/ArcaneCore" ]]; then
  echo "dist/ArcaneCore is missing. Run npm run build:core:linux first." >&2
  exit 3
fi

CFLAGS=( $(pkg-config --cflags gtk4 webkitgtk-6.0) )
LIBS=( $(pkg-config --libs gtk4 webkitgtk-6.0) )
cc -std=c11 -O2 -Wall -Wextra -Wpedantic "${CFLAGS[@]}" -DARCANE_APP='"provisioner"' "$SOURCE" -o "$DIST/ArcaneProvisioner" "${LIBS[@]}"
cc -std=c11 -O2 -Wall -Wextra -Wpedantic "${CFLAGS[@]}" -DARCANE_APP='"shell"' "$SOURCE" -o "$DIST/ArcaneShell" "${LIBS[@]}"
chmod 755 "$DIST/ArcaneProvisioner" "$DIST/ArcaneShell" "$DIST/ArcaneCore"
node "$ROOT/tools/write-release-manifest.mjs" linux
printf 'Arcane Linux WebKitGTK release is ready in %s\n' "$DIST"
