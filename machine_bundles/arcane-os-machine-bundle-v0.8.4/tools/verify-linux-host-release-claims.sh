#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_PROBE="$ROOT/tools/linux-host-release-claim-probe.c"
CORE_PROBE="$ROOT/tools/linux-host-release-claim-core-probe.c"
FIXTURE="$(mktemp -d)"
cleanup() {
  rm -rf -- "$FIXTURE"
}
trap cleanup EXIT

for package in gtk4 webkitgtk-6.0; do
  if ! pkg-config --exists "$package"; then
    echo "Missing Linux host-test dependency: $package" >&2
    exit 2
  fi
done

CFLAGS=( $(pkg-config --cflags gtk4 webkitgtk-6.0) )
LIBS=( $(pkg-config --libs gtk4 webkitgtk-6.0) )
cc -std=c11 -O2 -Wall -Wextra -Wpedantic "${CFLAGS[@]}" -DARCANE_APP='"provisioner"' \
  "$HOST_PROBE" -o "$FIXTURE/ArcaneProvisioner" "${LIBS[@]}"
cc -std=c11 -O2 -Wall -Wextra -Wpedantic "$CORE_PROBE" -o "$FIXTURE/ArcaneCore"
chmod 755 "$FIXTURE/ArcaneProvisioner" "$FIXTURE/ArcaneCore"
mkdir -p "$FIXTURE/app/provisioner"
printf '{}\n' > "$FIXTURE/arcane-bundle.json"
printf '{}\n' > "$FIXTURE/arcane-release.json"

run_with_hostile_claims() {
  local output_path="$1"
  shift
  env \
    ARCANE_HOST_PROBE_OUTPUT="$output_path" \
    ARCANE_BUNDLE_ROOT="$FIXTURE" \
    ARCANE_RELEASE_SECURITY_MODE='publisher-verified' \
    ARCANE_RELEASE_CONTENT_BINDING='hostile-binding' \
    ARCANE_RELEASE_SIGNER_THUMBPRINT='hostile-signer' \
    ARCANE_RELEASE_VERIFIED_AT='2099-01-01T00:00:00.000Z' \
    ARCANE_RELEASE_REVOCATION_STATUS='good' \
    ARCANE_RELEASE_TRUST_SOURCE='hostile-store' \
    ARCANE_RELEASE_TIMESTAMP_VERIFIED='1' \
    "$FIXTURE/ArcaneProvisioner" "$@"
}

assert_line() {
  local output_path="$1"
  local expected="$2"
  if ! grep -Fqx -- "$expected" "$output_path"; then
    echo "Linux host probe did not capture expected line: $expected" >&2
    sed -n '1,120p' "$output_path" >&2
    exit 3
  fi
}

assert_no_line() {
  local output_path="$1"
  local rejected="$2"
  if grep -Fqx -- "$rejected" "$output_path"; then
    echo "Linux host probe captured forbidden line: $rejected" >&2
    sed -n '1,120p' "$output_path" >&2
    exit 4
  fi
}

explicit_output="$FIXTURE/explicit.txt"
run_with_hostile_claims "$explicit_output" --allow-unsigned-local-release
assert_line "$explicit_output" $'arg\t--allow-unsigned-local-release'
assert_line "$explicit_output" $'env\tARCANE_RELEASE_SECURITY_MODE\tunsigned-local-test'
for claim in \
  ARCANE_RELEASE_CONTENT_BINDING \
  ARCANE_RELEASE_SIGNER_THUMBPRINT \
  ARCANE_RELEASE_VERIFIED_AT \
  ARCANE_RELEASE_REVOCATION_STATUS \
  ARCANE_RELEASE_TRUST_SOURCE \
  ARCANE_RELEASE_TIMESTAMP_VERIFIED; do
  assert_line "$explicit_output" $'env\t'"$claim"$'\t<unset>'
done
assert_no_line "$explicit_output" $'arg\t--allow-source-install'

unapproved_output="$FIXTURE/unapproved.txt"
run_with_hostile_claims "$unapproved_output"
assert_no_line "$unapproved_output" $'arg\t--allow-unsigned-local-release'
assert_line "$unapproved_output" $'env\tARCANE_RELEASE_SECURITY_MODE\t<unset>'

source_output="$FIXTURE/source.txt"
run_with_hostile_claims "$source_output" --allow-source-install
assert_line "$source_output" $'arg\t--allow-source-install'
assert_no_line "$source_output" $'arg\t--allow-unsigned-local-release'
assert_line "$source_output" $'env\tARCANE_RELEASE_SECURITY_MODE\t<unset>'

mv -- "$FIXTURE/arcane-release.json" "$FIXTURE/arcane-release.not-packaged"
unpackaged_output="$FIXTURE/unpackaged.txt"
run_with_hostile_claims "$unpackaged_output" --allow-unsigned-local-release
mv -- "$FIXTURE/arcane-release.not-packaged" "$FIXTURE/arcane-release.json"
assert_line "$unpackaged_output" $'arg\t--allow-unsigned-local-release'
assert_line "$unpackaged_output" $'env\tARCANE_RELEASE_SECURITY_MODE\t<unset>'

malformed_output="$FIXTURE/malformed.txt"
if run_with_hostile_claims "$malformed_output" --allow-unsigned-local-release=true \
    >"$FIXTURE/malformed.stdout" 2>"$FIXTURE/malformed.stderr"; then
  echo 'Linux host accepted an unsigned-local option with an attached value.' >&2
  exit 5
fi
if [[ -e "$malformed_output" ]]; then
  echo 'Linux host launched Core after rejecting a malformed unsigned-local option.' >&2
  exit 6
fi

printf 'Linux compiled host release-claim tests passed.\n'
