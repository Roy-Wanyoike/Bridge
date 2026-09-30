#!/usr/bin/env bash
# scripts/verify-ffi.sh — REAL cross-language FFI verification.
#
# Generates the FFI glue for the payments contract, builds the Rust
# cdylib, then runs the Go cgo client's tests AGAINST the built library —
# proving the buffer protocol, ownership rules, error plumbing and
# per-method dispatch over the C ABI on this machine. Skips gracefully
# when Go/Rust are missing. NOTE: this gate is local-only — it is not
# wired into any CI workflow (see docs/TESTING.md).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v go >/dev/null 2>&1; then
  echo "go toolchain not available — skipping (local-only gate; not wired into CI)"
  exit 0
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "rust toolchain not available — skipping (local-only gate; not wired into CI)"
  exit 0
fi

status=0

node scripts/generate-ffi.mjs || exit 1

RUST_DIR="examples/payments/generated/ffi/rust-ffi"
GO_DIR="examples/payments/generated/ffi/go-ffi"
CRATE_LIB="bridge_payments_v1_ffi"

echo "== cargo build --release (Rust cdylib)"
(cd "$RUST_DIR" && cargo build --release --quiet) || status=1

if [ "$status" -eq 0 ]; then
  echo "== go test -tags bridge_ffi_verify (cgo client against the built dylib)"
  (
    cd "$GO_DIR" && \
    CGO_ENABLED=1 \
    CGO_LDFLAGS_ALLOW='-L.*|-l.*' \
    CGO_LDFLAGS="-L$(cd "../rust-ffi/target/release" && pwd) -l$CRATE_LIB" \
    LD_LIBRARY_PATH="$(cd "../rust-ffi/target/release" && pwd):${LD_LIBRARY_PATH:-}" \
    go test -tags bridge_ffi_verify -v ./...
  ) || status=1
fi

if command -v rustup >/dev/null 2>&1; then
  if rustup target list --installed | grep -q wasm32-unknown-unknown; then
    echo "== cargo check --target wasm32-unknown-unknown (wasm crate)"
    (cd "examples/payments/generated/ffi/wasm" && cargo check --target wasm32-unknown-unknown --quiet) || status=1
  else
    echo "wasm32-unknown-unknown target not installed — skipping wasm check"
  fi
else
  echo "rustup not available — skipping wasm check"
fi

if [ "$status" -eq 0 ]; then
  echo "FFI verification: PASS"
else
  echo "FFI verification: FAIL"
fi
exit "$status"
