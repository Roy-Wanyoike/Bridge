# Serialization: cross-language round-trip specification

Bridge values must survive the trip between languages byte-for-byte. This
document pins the wire encoding for every Bridge primitive and collection;
`@bridge/serialization` implements it in TypeScript, and three independent
reference runtimes — Go, Rust, Python — verify the same **executable golden
vectors** ([`vectors/vectors.json`](../packages/bridge-serialization/vectors/vectors.json))
on every run of `scripts/verify-serialization.sh`.

## The golden vectors

Each of the 50 vectors carries:

| Field      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `id`       | Stable name (e.g. `int_beyond_2p53`, `timestamp_pre1970_nano`).       |
| `model`    | The value in **tagged representation** (below) — no ambiguities.      |
| `json`     | The canonical JSON text (integers as exact digits).                   |
| `msgpack`  | The exact MessagePack bytes, hex.                                     |
| `cbor`     | The exact CBOR bytes, hex.                                            |

Every runtime must (1) encode the model to those exact bytes and (2) decode
those bytes back to the model. 50 vectors × 2 formats × 2 directions = 200
byte-exact checks per runtime.

The file also carries **reject vectors** (`rejects`): bytes that are
well-formed on the wire but carry values outside the Bridge model — NaN and
±Infinity floats, or bignum content under timestamp tag 1. Every runtime must
REFUSE them: the decoder or the model mapping raises, never returns a value.

## Tagged representation (the model)

JSON cannot distinguish i64 from f64, bytes from strings, or a timestamp
from a string — so the vectors carry an explicit tagged form:

| Tagged                        | Bridge value                  |
| ----------------------------- | ----------------------------- |
| `{"t":"null"}`                | null                          |
| `{"t":"bool","v":true}`       | boolean                       |
| `{"t":"i64","v":"-42"}`       | signed 64-bit integer (digits)|
| `{"t":"u64","v":"42"}`        | unsigned 64-bit integer       |
| `{"t":"f64","v":3.14}`        | binary64 float (negative zero is the string `"-0.0"` — JSON numbers cannot carry the sign) |
| `{"t":"str","v":"hello"}`     | string                        |
| `{"t":"decimal","v":"19.99"}` | decimal (textual, never float)|
| `{"t":"uuid","v":"550e8400-…"}`| uuid (textual)               |
| `{"t":"enum","v":"high"}`     | enum variant (never ordinal)  |
| `{"t":"bytes","b64":"AAEC/w=="}` | binary (base64)            |
| `{"t":"timestamp","iso":"2024-06-04T15:40:00Z"}` | timestamp (RFC 3339 UTC; `BridgeTimestamp` = int64 seconds + 0..999,999,999 ns) |
| `{"t":"array","v":[…]}`       | list                          |
| `{"t":"set","v":[…]}`         | set (sorted + deduped)        |
| `{"t":"map","v":{"k":…}}`     | map (string keys)             |

The tagged model is also the integration seam for generated code: language
generators map Bridge types onto these same semantics.

## Canonical wire rules (both formats)

1. **Integers** — i64/u64 always encoded as integers, never floats. The
   canonical range is ±2^63; values beyond 2^53 (e.g. `9007199254740993`)
   are covered by vectors and MUST NOT pass through `double`.
2. **Floats** — always binary64 (`0xcb` msgpack / `0xfb` cbor) on encode;
   decoders widen half/single forms leniently (interoperability).
3. **Map keys** — strings only, sorted by **UTF-8 byte order** (plain
   bytewise — deliberately NOT RFC 8949 §4.2 length-first; one order shared
   by all formats and languages).
4. **Undefined/absent** — map entries whose value is `undefined` are dropped
   (absent optional). Explicit `null` is preserved.
5. **Sets** — encoded as sorted, deduped arrays (numbers numerically,
   strings by UTF-8 byte order = code-point order, `false` < `true` — the
   exact order every Bridge language generator emits, #117). Decoders
   return a plain array; set-typed fields re-apply sorting/dedup at the
   model layer.
6. **Decimals/uuids/enums** — textual; never parsed to floats or ordinals.

### Timestamps: the precision contract (#46)

A Bridge timestamp is the pair **(seconds: int64, nanos: 0..999,999,999)** —
nanos are always a non-negative offset, so `1969-12-31T23:59:59.5Z` is
`seconds = -1`, `nanos = 500000000` (never `-0.5s`). RFC 3339 parsing and
rendering are **arithmetic** (proleptic Gregorian, Hinnant's civil-date
algorithms) in every runtime — never `Date.parse`/`datetime`/`time.Time`,
whose binary64 seconds, microsecond precision, or year range would lose
data. Consequences, all pinned by vectors:

- **Whole seconds are always exact** in both formats, for the full int64
  range (`timestamp_int64max_seconds`, `timestamp_int64min_seconds`).
- **MessagePack** (timestamp96, `c7 0c ff` + u32 nanos + i64 seconds) is
  **exact to the nanosecond** for every representable value, including
  pre-1970 sub-second (`timestamp_pre1970_nano` = `-1s + 1ns`).
- **CBOR** tag 1 is exact for whole seconds (integer content, RFC 8949
  §3.4.2 preferred form). Fractional seconds ride a binary64 epoch, so
  **sub-µs nanos are rounded to the nearest representable double** at
  2024-epoch magnitudes (~238 ns granularity; exact at epoch-zero
  magnitudes — `timestamp_subms_epoch` and `timestamp_subus_epoch` carry
  123,456 ns and 1 ns losslessly). Decode splits the float epoch with
  **floor semantics** — epoch `-0.5` → `(-1, 500000000)` — which is the
  exact inverse of the encoder, so pre-1970 fractional timestamps
  round-trip symmetrically (encode → decode → encode is byte-stable).
  This is the documented per-format divergence from msgpack: prefer
  msgpack when sub-µs precision must survive.
- **Rejects**: NaN/±Infinity are not Bridge values in any format or position
  (top-level floats and tag-1 contents alike); tag 1 carrying a bignum is a
  decode error.

### MessagePack specifics

- Canonical timestamp: **timestamp96** — `c7 0c ff` + 12-byte payload,
  big-endian `u32 nanos` then `i64 seconds` (verified byte-compatible with
  Python `msgpack` and Go `vmihailenco/msgpack/v5` decoders). Decoders must
  also accept timestamp 32/64 forms.
- Bytes: `bin` family (`c4`–`c6`), never str.
- Minimal-length encodings for ints and str/bin/array/map heads.

### CBOR specifics

- Canonical timestamp: **tag 1**. Whole seconds encode as an integer epoch
  (minimal-length major 0/1 — RFC 8949 §3.4.2 preferred form, e.g.
  `c1 1a 665f3550`, exact over the full int64 range). Fractional seconds
  encode as `c1 fb <binary64 epoch>`. Decoders must accept both contents
  and split float epochs with floor semantics (see the precision contract
  above).
- Minimal-length arguments everywhere (RFC 8949 preferred serialization).
- Only definite lengths; tags other than 1 are decode errors.

## Verification matrix

`scripts/verify-serialization.sh` runs, per language:

| Runtime | Encode byte-identity | Decode via reference library            |
| ------- | -------------------- | --------------------------------------- |
| TypeScript | `@bridge/serialization` codecs | same package + node:test suite |
| Go     | hand-rolled canonical writer (`runtimes/go/verify.go`) | `vmihailenco/msgpack/v5` + `fxamacker/cbor/v2` |
| Rust   | hand-rolled canonical writer (`runtimes/rust/src/main.rs`) | `rmpv` + `ciborium` |
| Python | canonical writer via stdlib `struct` + libs | `msgpack` + `cbor2` |

Timestamp decode runs through each runtime's own arithmetic calendar code
(structural tag-1 / timestamp96 handling in Go, value-tree decoders in Rust,
`semantic_decoders` override in Python) because the reference libraries'
built-in epoch→datetime semantics cannot represent the int64-second extremes.

All 200 vector checks + 7 reject checks pass in all four languages: the same
model produces the same bytes everywhere, every reference decoder reads
Bridge bytes back to the same value, and out-of-model bytes are refused
everywhere. This is the guarantee generated serializers build on.

## Adding a vector

1. Add the value to `packages/bridge-serialization/scripts/generate-vectors.mjs`.
2. `node scripts/generate-vectors.mjs` — regenerates `vectors/vectors.json`
   deterministically.
3. `npm test --workspace @bridge/serialization` — the TS vector suite covers it.
4. Run `scripts/verify-serialization.sh` — the Go/Rust/Python runtimes cover it.
