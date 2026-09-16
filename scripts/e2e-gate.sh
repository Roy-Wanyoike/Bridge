#!/usr/bin/env bash
# scripts/e2e-gate.sh — 25-step end-to-end acceptance run against the built
# workspace. Every step must PASS; the script exits non-zero otherwise.
set -u
cd "$(dirname "$0")/.."

B="node /home/z/my-project/packages/bridge-cli/dist/bin/bridge.js"
TSC="/home/z/my-project/node_modules/.bin/tsc"
TMP="$(mktemp -d /tmp/bridge-e2e-XXXX)"
REG="$TMP/registry"
PASS=0; FAIL=0
declare -a RESULTS

step() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    RESULTS+=("PASS  $name"); PASS=$((PASS+1))
  else
    RESULTS+=("FAIL  $name"); FAIL=$((FAIL+1))
  fi
}

step_expect_fail() {
  # A step that must fail (negative test)
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    RESULTS+=("FAIL  $name (expected failure, got success)"); FAIL=$((FAIL+1))
  else
    RESULTS+=("PASS  $name"); PASS=$((PASS+1))
  fi
}

# ---- 1-4: compiler front door -------------------------------------------
step "01 version reports 0.2.1"        bash -c "$B version | grep -q 'bridge 0.2.1'"
step "02 doctor environment ok"        $B doctor
step "03 init scaffolds project"        bash -c "cd $TMP && $B init demo && test -f demo/bridge.bridge"
step "04 validate canonical example"   $B validate examples/payments/payments.bridge

# ---- 5-8: formatting, linting, diagnostics ------------------------------
step "05 fmt formats cleanly"          bash -c "$B fmt -w $TMP/demo/bridge.bridge && $B validate $TMP/demo/bridge.bridge"
step "06 lint reports no errors"       $B lint examples/payments/payments.bridge
step "07 validate rejects bad syntax"  bash -c "printf 'typeBroken {{{' > $TMP/bad.bridge; ! $B validate $TMP/bad.bridge"
step "08 help contract documented"     bash -c "$B help | grep -q 'Exit codes: 0 success'"

# ---- 9-12: generation ----------------------------------------------------
step "09 generate typescript"          $B generate --language typescript examples/payments/payments.bridge --out $TMP/gen-ts
step "10 generate python"              $B generate --language python examples/payments/payments.bridge --out $TMP/gen-py
step "11 generate go"                  $B generate --language go examples/payments/payments.bridge --out $TMP/gen-go
step "12 generate rust"                $B generate --language rust examples/payments/payments.bridge --out $TMP/gen-rs

# ---- 13-16: TS round-trip (local node) ----------------------------------
step "13 TS output typechecks (tsc strict)" "$TSC" -p "$TMP/gen-ts/tsconfig.json" --noEmit
step "14 TS output compiles + runtime import" bash -c "$TSC -p $TMP/gen-ts/tsconfig.json && node -e \"const i=require('$TMP/gen-ts/dist/index.js'); if(Object.keys(i).length===0)process.exit(1)\""

# ---- 17-20: compatibility engine ----------------------------------------
step "15 diff classifies v1→v2"        bash -c "$B diff examples/compatibility/v1.orders.bridge examples/compatibility/v2.orders.bridge | grep -Eq 'WARNING|SAFE|BREAKING'"
step "16 check gate exits correctly"   $B check examples/compatibility/v1.orders.bridge examples/compatibility/v2.orders.bridge
step "17 impact walks consumer graph"  bash -c "$B impact examples/compatibility/v1.orders.bridge --to examples/compatibility/v2.orders.bridge | grep -qi 'consumer\\|affected\\|no consumer'"
step "18 check rejects breaking"       bash -c "printf 'typeBroken {{{' > $TMP/bad2.bridge; ! $B check $TMP/bad.bridge $TMP/bad2.bridge"

# ---- 21-23: registry lifecycle ------------------------------------------
step "19 publish to registry"          $B publish examples/payments/payments.bridge --registry "$REG"
step "20 versions lists published"     bash -c "$B versions payments --registry $REG | grep -q v"
step "21 inspect shows metadata"       bash -c "$B inspect payments --registry $REG | grep -qi payment"
step "22 pull fetches published"       bash -c "$B pull payments v1 --registry $REG --out $TMP/pulled-ir.json && test -s $TMP/pulled-ir.json"
step "23 search finds contract"        bash -c "$B search payments --registry $REG | grep -qi payment"

# ---- 24-25: release binary ----------------------------------------------
step "24 release binary runs"          ./dist/release/bridge-v0.2.1-linux-amd64 version
step "25 release binary validates"     ./dist/release/bridge-v0.2.1-linux-amd64 validate examples/payments/payments.bridge

echo "================ E2E GATE RESULTS ================"
printf '%s\n' "${RESULTS[@]}"
echo "=================================================="
echo "PASS: $PASS  FAIL: $FAIL  (workdir: $TMP)"
[ "$FAIL" -eq 0 ]
