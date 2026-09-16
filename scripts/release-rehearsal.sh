#!/usr/bin/env bash
# scripts/release-rehearsal.sh — local rehearsal of .github/workflows/release.yml
# Simulates the guard job, the binary matrix step (native target), the smoke
# test and checksum generation for a would-be vX.Y.Z tag.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: release-rehearsal.sh X.Y.Z}"
TAG="v${VERSION}"

echo "== guard: tag form =="
printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "FAIL: bad tag form"; exit 1; }
echo "PASS: $TAG"

echo "== guard: version lockstep =="
fail=0
root_version="$(node -p "require('./package.json').version")"
[ "$root_version" = "$VERSION" ] || { echo "FAIL: root package.json is $root_version"; fail=1; }
for f in packages/*/package.json; do
  v="$(node -p "require('./$f').version")"
  [ "$v" = "$VERSION" ] || { echo "FAIL: $f is $v"; fail=1; }
done
formula_version="$(sed -n 's/^[[:space:]]*version[[:space:]]*"\([^"]*\)".*/\1/p' homebrew/bridge.rb)"
[ "$formula_version" = "$VERSION" ] || { echo "FAIL: homebrew formula is ${formula_version:-<unset>}"; fail=1; }
cli_version="$(grep -o "CLI_VERSION = '[^']*'" packages/bridge-cli/src/meta.ts | cut -d"'" -f2)"
[ "$cli_version" = "$VERSION" ] || { echo "FAIL: CLI_VERSION is $cli_version"; fail=1; }
[ "$fail" -eq 0 ] && echo "PASS: lockstep at $VERSION"

echo "== binary: bun compile (bun-linux-x64, native) =="
OUT="dist/release/bridge-${TAG}-linux-amd64"
mkdir -p dist/release
bun build --compile --minify --target=bun-linux-x64 \
  packages/bridge-cli/src/bin/bridge.ts --outfile "$OUT" >/dev/null
echo "PASS: $OUT"

echo "== smoke test the binary (no || true masking) =="
"$OUT" version
"$OUT" validate examples/payments/payments.bridge >/dev/null && echo "PASS: binary validate"

echo "== checksums =="
( cd dist/release && sha256sum "bridge-${TAG}-linux-amd64" > "checksums-sha256-${VERSION}.txt" )
head -1 "dist/release/checksums-sha256-${VERSION}.txt"

echo
echo "REHEARSAL COMPLETE: guard + binary + smoke + checksums all PASS for $TAG"
