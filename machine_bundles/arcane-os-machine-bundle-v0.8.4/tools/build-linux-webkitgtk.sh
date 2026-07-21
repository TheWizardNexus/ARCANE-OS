#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
RELEASE="$DIST/linux"
SOURCE="$ROOT/src/hosts/linux/arcane_host.c"
if [[ $# -ne 1 || "$1" != "--unsigned-local-test" ]]; then
  echo 'Linux publication is currently available only as an explicit unsigned local-test build.' >&2
  echo 'Run: npm run build:distribution:linux:unsigned-local-test' >&2
  exit 2
fi
mkdir -p "$DIST"

for package in gtk4 webkitgtk-6.0; do
  if ! pkg-config --exists "$package"; then
    echo "Missing Linux build dependency: $package" >&2
    echo "Debian/Ubuntu example: sudo apt install build-essential libgtk-4-dev libwebkitgtk-6.0-dev" >&2
    exit 2
  fi
done
bash "$ROOT/tools/verify-linux-host-release-claims.sh"
if [[ ! -x "$DIST/ArcaneCore" ]]; then
  echo "dist/ArcaneCore is missing. Run npm run build:core:linux first." >&2
  exit 3
fi

STAGE="$(mktemp -d "$DIST/.linux.stage.XXXXXX")"
BACKUP="$DIST/.linux.backup.$$"
cleanup() {
  rm -rf -- "$STAGE"
  if [[ -e "$BACKUP" && ! -e "$RELEASE" ]]; then mv -- "$BACKUP" "$RELEASE"; fi
}
trap cleanup EXIT

cp -a -- "$DIST/app" "$STAGE/app"
cp -- "$DIST/ArcaneCore" "$STAGE/ArcaneCore"
cp -- "$DIST/arcane-bundle.json" "$STAGE/arcane-bundle.json"

CFLAGS=( $(pkg-config --cflags gtk4 webkitgtk-6.0) )
LIBS=( $(pkg-config --libs gtk4 webkitgtk-6.0) )
cc -std=c11 -O2 -Wall -Wextra -Wpedantic "${CFLAGS[@]}" -DARCANE_APP='"provisioner"' "$SOURCE" -o "$STAGE/ArcaneProvisioner" "${LIBS[@]}"
cc -std=c11 -O2 -Wall -Wextra -Wpedantic "${CFLAGS[@]}" -DARCANE_APP='"shell"' "$SOURCE" -o "$STAGE/ArcaneShell" "${LIBS[@]}"
chmod 755 "$STAGE/ArcaneProvisioner" "$STAGE/ArcaneShell" "$STAGE/ArcaneCore"
node "$ROOT/tools/write-release-manifest.mjs" linux "$STAGE"
node "$ROOT/tools/verify-built-release.mjs" "$STAGE" linux

if [[ -e "$BACKUP" ]]; then
  echo "Refusing to overwrite unexpected Linux release backup: $BACKUP" >&2
  exit 4
fi
if [[ -e "$RELEASE" ]]; then mv -- "$RELEASE" "$BACKUP"; fi
mv -- "$STAGE" "$RELEASE"
if [[ -e "$BACKUP" ]]; then rm -rf -- "$BACKUP"; fi
trap - EXIT
printf 'Arcane Linux WebKitGTK UNSIGNED LOCAL-TEST release is ready in %s\n' "$RELEASE"
