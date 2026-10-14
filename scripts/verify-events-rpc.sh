#!/usr/bin/env bash
# Cross-language verification for the events + RPC wire contracts (#16, #17).
#
# Proves, over real TCP loopback, that every generated language speaks the
# same wire:
#   1. generated TypeScript compiles (tsc --strict)
#   2. generated Go builds + vet + its shipped httptest round-trip tests pass
#   3. generated Rust builds + its shipped loopback tests/roundtrip.rs pass
#   4. generated Python compiles + runs functional events/HTTP round-trips
#   5. TS client -> Python server over real HTTP (cross-language RPC)
#   6. TS dispatcher decodes a Python-emitted event envelope (cross-language events)
#
# Usage: scripts/verify-events-rpc.sh
#
# NOTE: this gate is local-only — it is not wired into any CI workflow
# (see docs/TESTING.md); it needs npx tsx + real TCP loopback and is left
# as a developer-run gate for now.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/bridge-events-rpc-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
CONTRACT="$ROOT/examples/events-rpc/store.bridge"
CLI="$ROOT/packages/bridge-cli/dist/bin/bridge.js"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n== %s\n' "$1"; }

cd "$ROOT"
node "$CLI" validate "$CONTRACT" > /dev/null || fail "contract must validate"
pass "contract validates"

# ---------------------------------------------------------------- TS
step "1/6 TypeScript: generate + strict compile"
node "$CLI" generate "$CONTRACT" --language typescript --out "$WORK/ts" --force > /dev/null
TSC="$ROOT/node_modules/.bin/tsc"
"$TSC" --strict --noEmit --target es2022 --module commonjs --moduleResolution node \
  --skipLibCheck --lib es2022,dom "$WORK"/ts/src/*.ts
pass "tsc --strict clean"

# ---------------------------------------------------------------- Go
step "2/6 Go: generate + build + vet + test"
GO_BIN="${GO:-go}"
if ! command -v "$GO_BIN" > /dev/null 2>&1; then
  echo "  SKIP Go toolchain not available (set GO=<path-to-go> to override)"; GO_BIN=""
fi
if [ -n "$GO_BIN" ]; then
  node "$CLI" generate "$CONTRACT" --language go --out "$WORK/go" --force > /dev/null
  (cd "$WORK/go" && "$GO_BIN" build ./... && "$GO_BIN" vet ./... && "$GO_BIN" test ./... > /dev/null)
  pass "go build + vet + test"
fi

# ---------------------------------------------------------------- Rust
step "3/6 Rust: generate + cargo test"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
if command -v cargo > /dev/null 2>&1; then
  node "$CLI" generate "$CONTRACT" --language rust --out "$WORK/rs" --force > /dev/null
  (cd "$WORK/rs" && cargo test --quiet > /dev/null)
  pass "cargo test (loopback round-trips)"
else
  echo "  SKIP Rust toolchain not available"
fi

# ---------------------------------------------------------------- Python
step "4/6 Python: generate + functional events + HTTP round-trip"
node "$CLI" generate "$CONTRACT" --language python --out "$WORK/py" --force > /dev/null
python3 - "$WORK/py" << 'PYEOF'
import sys, threading
from http.server import HTTPServer
sys.path.insert(0, sys.argv[1])
from store_v1 import (CreateOrderRequest, OrdersClient, OrdersServiceHandler, make_orders_handler,
                      Order, OrderPlaced, OrderShipped, BridgeEventMeta,
                      encode_order_placed, decode_order_placed, InMemoryEventBus,
                      register_order_placed, BridgeEventDispatcher, BridgeRpcError,
                      BridgeServiceError, ORDER_PLACED_TYPE)

payload = OrderPlaced(order_id='evt-1', total_cents=1999, currency='USD')
meta = BridgeEventMeta(id='e1', source='//orders', time='2026-09-04T12:00:00Z')
env = encode_order_placed(payload, meta)
decoded, _ = decode_order_placed(env)
assert decoded == payload and env['type'] == ORDER_PLACED_TYPE == 'store.v1.OrderPlaced'

bus = InMemoryEventBus()
seen = []
unsub = bus.subscribe(ORDER_PLACED_TYPE, lambda e: seen.append(e))
bus.publish(ORDER_PLACED_TYPE, payload.to_dict(), meta)
assert seen and seen[0]['data']['total_cents'] == 1999
unsub()

dispatched = []
d = BridgeEventDispatcher()
register_order_placed(d, lambda p, m: dispatched.append((p.order_id, m.id)))
d.dispatch(env)
assert dispatched == [(payload.order_id, 'e1')]

class Handler(OrdersServiceHandler):
    def create_order(self, request):
        if request.total_cents == 0:
            raise BridgeRpcError('invalid_argument', 'total must be positive')
        return Order(id='ord-1', total_cents=request.total_cents, currency=request.currency)

httpd = HTTPServer(('127.0.0.1', 0), make_orders_handler(Handler()))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
client = OrdersClient(f'http://127.0.0.1:{port}')
resp = client.create_order(CreateOrderRequest(total_cents=2500, currency='EUR'))
assert resp.id == 'ord-1'
try:
    client.create_order(CreateOrderRequest(total_cents=100, currency='EURO'))
    raise SystemExit('constraint violation must fail')
except BridgeServiceError as e:
    assert e.status == 400 and 'length' in e.body
try:
    client.create_order(CreateOrderRequest(total_cents=0, currency='USD'))
    raise SystemExit('BridgeRpcError must map')
except BridgeServiceError as e:
    assert e.status == 400
httpd.shutdown()
print('PY-OK')
PYEOF
pass "python events + HTTP round-trip + validation"

# ------------------------------------------------- Cross-language RPC + events
step "5/6 Cross-language: TS client -> Python server (real HTTP)"
python3 - "$WORK/py" > "$WORK/port" << 'PYEOF' &
import sys, threading, json
from http.server import HTTPServer
sys.path.insert(0, sys.argv[1])
from store_v1 import CreateOrderRequest, OrdersServiceHandler, make_orders_handler, Order, OrderPlaced, BridgeEventMeta, encode_order_placed

class Handler(OrdersServiceHandler):
    def create_order(self, request):
        return Order(id='ord-crosslang', total_cents=request.total_cents, currency=request.currency)

httpd = HTTPServer(('127.0.0.1', 0), make_orders_handler(Handler()))
print(httpd.server_address[1], flush=True)
env = encode_order_placed(OrderPlaced(order_id='evt-cross', total_cents=42, currency='USD'),
                          BridgeEventMeta(id='e1', source='py://orders', time='2026-09-04T12:00:00Z'))
open(sys.argv[1] + '/../py_envelope.json', 'w').write(json.dumps(env))
httpd.serve_forever()
PYEOF
PY_PID=$!
sleep 1.5
PORT=$(cat "$WORK/port")
cat > "$WORK/ts_client.mjs" << EOF
import { createOrdersClient } from '$WORK/ts/src/services.ts';
import { decodeOrderPlaced } from '$WORK/ts/src/events.ts';
import { readFileSync } from 'node:fs';
const client = createOrdersClient({ baseUrl: 'http://127.0.0.1:${PORT}' });
const order = await client.createOrder({ total_cents: 777, currency: 'GBP' });
if (order.id !== 'ord-crosslang') throw new Error('unexpected response: ' + JSON.stringify(order));
console.log('  TS->PY RPC ok:', JSON.stringify(order));
const envelope = JSON.parse(readFileSync('$WORK/py_envelope.json', 'utf8'));
const decoded = decodeOrderPlaced(envelope);
if (decoded.type !== 'store.v1.OrderPlaced' || decoded.data.total_cents !== 42) {
  throw new Error('envelope mismatch: ' + JSON.stringify(decoded));
}
console.log('  PY envelope -> TS dispatcher ok');
EOF
if ! npx --yes tsx@4 "$WORK/ts_client.mjs"; then
  kill "$PY_PID" 2>/dev/null || true
  fail "cross-language TS->PY"
fi
kill "$PY_PID" 2>/dev/null || true
pass "TS client -> Python server + PY envelope -> TS dispatcher"

step "6/6 Determinism: generate twice, byte-identical"
node "$CLI" generate "$CONTRACT" --language typescript --out "$WORK/ts2" --force > /dev/null
node "$CLI" generate "$CONTRACT" --language rust --out "$WORK/rs2" --force > /dev/null
# Cargo.lock is produced by cargo itself during step 3 and is not generator output.
diff -r -x Cargo.lock -x target "$WORK/ts" "$WORK/ts2" > /dev/null && diff -r -x Cargo.lock -x target "$WORK/rs" "$WORK/rs2" > /dev/null
pass "byte-identical regeneration"

printf '\nverify-events-rpc: ALL PASS\n'
