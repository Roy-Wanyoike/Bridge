#!/usr/bin/env bash
# scripts/verify-ts.sh — type-check generated TypeScript for every example.
#
# Regenerates code on the fly (scripts/generate-all.mjs), then runs the
# workspace TypeScript compiler over each examples/*/generated/typescript
# package (strict mode, per its generated tsconfig.json). Asserts 0 errors.
# Exit status: 0 when everything passes, 1 on any compile error.
#
# CI: wired into the build-test job of .github/workflows/ci.yml (after the
# Test step). Still runnable locally: bash scripts/verify-ts.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TSC="$ROOT/node_modules/typescript/bin/tsc"
if [ ! -f "$TSC" ]; then
  echo "workspace TypeScript not found — run 'npm install' at the repository root first"
  exit 1
fi

node scripts/generate-all.mjs || exit 1

status=0
for pkg in examples/*/generated/typescript; do
  [ -f "$pkg/tsconfig.json" ] || continue
  echo "== $pkg"
  "$TSC" -p "$pkg" --noEmit || status=1
done

if [ "$status" -eq 0 ]; then
  echo "TypeScript verification: PASS (0 errors)"
else
  echo "TypeScript verification: FAIL"
fi
exit "$status"
