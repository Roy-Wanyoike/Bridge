# FFI: one contract, callable across language boundaries

Bridge contracts already compile to data types in six languages. The FFI
generator (`@bridge/ffi`) completes the picture: it also compiles a
contract's **service methods** into native function calls, so a single
contract carries behavior — not just shapes — across a language boundary.

Three targets ship today:

| Target | Produces | Consumed by |
|--------|----------|-------------|
| `rust-ffi` | a `cdylib` crate: canonical Rust types + a C-ABI surface | any C-ABI caller (Go, Python/ctypes, C, …) |
| `go-ffi` | a cgo client package that includes the **same generated C header** | Go services calling into the Rust library |
| `wasm` | a wasm32 crate (`wasm-bindgen`) + typed TypeScript wrappers | browsers, Node, Edge runtimes |

## The C-ABI contract

Every generated library follows one deterministic surface (`abi.ts` is the
single source of truth):

- **Symbols**: `bridge_<package>_<service>_<method>_call` (snake_cased),
  plus `<package>_free`, `<package>_echo_call` (probe) and
  `<package>_install_demo_handlers`.
- **Buffers**: one input buffer (request JSON) in, one output buffer
  (response JSON) out. The callee allocates the output; the caller releases
  it with `<package>_free` — the single ownership rule.
- **Status codes**: `0` ok · `1` panic · `2` invalid request JSON ·
  `3` handler error · `4` no handler installed · `5` validation failed.
  Non-zero statuses carry `{"error": {"code", "message"}}` in the output
  buffer.
- **Panic containment**: every entry point runs under `catch_unwind`; a
  Rust panic becomes status `1`, never an unwind across FFI.
- **Handlers**: the embedder registers typed handlers via
  `install_handlers(Handlers { .. })`. Handler presence is checked BEFORE
  request parsing, so dispatch is probe-able without a valid payload.

The shared header (`include/bridge_<package>.h`) is emitted once and
included by both the Rust side (definitions) and the Go side (declaration),
which makes ABI drift a compile error instead of a runtime surprise.

## Cross-language verification

`scripts/verify-ffi.sh` is a real end-to-end proof, run locally (it is a local-only gate, not wired into any CI workflow):

1. Generate the Rust crate + Go client for the payments contract.
2. `cargo build --release` the cdylib.
3. `go test -tags bridge_ffi_verify` — the cgo client links the built
   library and asserts:
   - `Echo` round-trips JSON through allocate → call → free,
   - invalid JSON produces a typed `BridgeCallError` with the canonical body,
   - per-method dispatch reports `no_handler` before handlers are installed.
4. `cargo check --target wasm32-unknown-unknown` validates the WASM crate.

The Rust side additionally runs its own ABI self-tests via `cargo test`.

## WASM scope

Browsers have no dynamic-library loader, so the WASM target carries the
contract's **data surface**: every struct type gets a
`<Type>Wasm` wrapper with `fromJson` / `toJson` / `validate`, executed
with Rust-side correctness (serde + the generated validators). Function
dispatch across FFI is the C-ABI targets' job.

## Example

```bash
node scripts/generate-ffi.mjs                     # generates glue for payments
cd examples/payments/generated/ffi/rust-ffi
cargo build --release                             # libbridge_payments_v1_ffi.so
cd ../go-ffi
CGO_LDFLAGS="-L../rust-ffi/target/release -lbridge_payments_v1_ffi" \
  LD_LIBRARY_PATH="../rust-ffi/target/release" \
  go test -tags bridge_ffi_verify ./...           # Go calls Rust through C
```
