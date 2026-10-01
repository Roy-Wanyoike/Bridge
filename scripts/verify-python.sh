#!/usr/bin/env bash
# scripts/verify-python.sh — verify generated Python for every example.
#
# Regenerates code on the fly (scripts/generate-all.mjs), then for each
# examples/*/generated/python: ast.parse every module, import the package,
# and run a generic to_dict/from_dict round-trip for every dataclass.
# Exit status: 0 when everything passes, 1 on the first category of failure,
# and 77 (overridable via SKIP_EXITS) with a "SKIP <reason>" on stderr when
# python3 is unavailable. NOTE: this gate is local-only — it is not
# wired into any CI workflow (see docs/TESTING.md).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "SKIP python3 not available (local-only gate; not wired into CI)" >&2
  exit "${SKIP_EXITS:-77}"
fi

node scripts/generate-all.mjs || exit 1

status=0
for pkg in examples/*/generated/python; do
  [ -d "$pkg" ] || continue
  echo "== $pkg"
  "$PY" scripts/python_roundtrip.py "$pkg" || status=1
done

if [ "$status" -eq 0 ]; then
  echo "Python verification: PASS"
else
  echo "Python verification: FAIL"
fi
exit "$status"
