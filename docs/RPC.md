# RPC transports

Bridge generates typed RPC clients and HTTP server adapters from `service`
declarations. The wire shape is deliberately boring: JSON over HTTP POST —
the same shape every generated language emits, so any client works against
any server.

## Wire shape

```
POST /{package}/{Service}/{Method}
Content-Type: application/json
```

- **Request**: the JSON serialization of the request struct. Generated
  validators run server-side before the handler is invoked; violations are
  rejected without touching user code.
- **Response 200**: the JSON serialization of the response struct.
- **Error response**: `{"code": string, "message": string}` with an HTTP
  status from the canonical mapping below.
- Non-POST requests → `405 method_not_allowed`; unknown route → `404
  not_found`; undecodable body → `400 invalid_argument`.

### Error-code → HTTP status mapping

The identical table is emitted in every generated language (and enforced on
both ends, so clients see the same status the server produced):

| Code                 | Status |
| -------------------- | ------ |
| `invalid_argument`   | 400    |
| `unauthenticated`    | 401    |
| `permission_denied`  | 403    |
| `not_found`          | 404    |
| `method_not_allowed` | 405    |
| `already_exists`     | 409    |
| `failed_precondition`| 412    |
| `resource_exhausted` | 429    |
| `unimplemented`      | 501    |
| `internal`           | 500    |
| `unavailable`        | 503    |
| `deadline_exceeded`  | 504    |

Unknown codes map to 500. Handlers raise `BridgeRpcError(code, message)`
(controlled errors) or return other errors (→ 500 `internal`).

## What gets generated

For each service, per language — a client and a server side:

| Language   | Client                                   | Server adapter                          |
| ---------- | ---------------------------------------- | --------------------------------------- |
| TypeScript | `create<Service>Client({ baseUrl, fetchImpl? })` on `fetch` | `create<Service>RequestListener(handler)` — a node:http request listener |
| Python     | `<Service>Client(base_url)` on `urllib`  | `make_<service>_handler(handler)` — a `http.server` binding |
| Go         | `New<Service>JSONClient(doer, baseURL)` on `net/http` | `New<Service>Handler(server)` — an `http.Handler` |
| Rust       | `<Service>HttpClient::new(base_url)` on stdlib TCP | `serve_once` / `serve_forever` on `std::net::TcpListener` |
| Java       | `new <Service>Client(baseUrl)` on `java.net.http` | `<Service>HttpServer` — an adapter on the JDK's built-in `com.sun.net.httpserver` |
| C#         | `new <Service>Client(baseUrl)` on `System.Net.Http.HttpClient` | `<Service>HttpListenerServer` — an adapter on `System.Net.HttpListener` |

All server adapters share the same behavior:

1. route parsing (`/{package}/{Service}/{Method}`);
2. JSON decode of the request body;
3. **constraint validation** via the generated validators (`@length`,
   `@email`, `@min`, …) — 400 `invalid_argument` with joined messages;
4. invocation of the handler implementation;
5. error mapping through the canonical table.

Rust's HTTP layer is implemented on `std::net` directly — generated crates
depend only on `serde`/`serde_json` plus the standard library.

## Example

```bridge
package store.v1

type CreateOrderRequest {
    total_cents: int64 @min(1)
    currency: string @length(3)
}

type Order {
    id: uuid
    total_cents: int64
    currency: string @length(3)
}

service Orders {
    CreateOrder(CreateOrderRequest) -> Order
}
```

Python server + Python client:

```python
from http.server import HTTPServer
from store_v1 import OrdersServiceHandler, make_orders_handler, OrdersClient, CreateOrderRequest

class Handler(OrdersServiceHandler):
    def create_order(self, request):
        return Order(id="...", total_cents=request.total_cents, currency=request.currency)

httpd = HTTPServer(("127.0.0.1", 8080), make_orders_handler(Handler()))
httpd.serve_forever()
```

```python
client = OrdersClient("http://127.0.0.1:8080")
order = client.create_order(CreateOrderRequest(total_cents=2500, currency="EUR"))
```

TypeScript client against that same Python server:

```typescript
import { createOrdersClient } from "./generated/typescript/src/services.js";
const client = createOrdersClient({ baseUrl: "http://127.0.0.1:8080" });
const order = await client.createOrder({ total_cents: 777, currency: "GBP" });
```

The cross-language pairing above is not aspirational: it runs in
[`scripts/verify-events-rpc.sh`](../scripts/verify-events-rpc.sh) — a
local gate, not wired into any CI workflow — and generated Rust/Go crates
carry their own loopback tests
(`tests/roundtrip.rs`, `roundtrip_test.go`).

## Transport roadmap

The JSON-over-HTTP shape is the v1 contract. Planned transports (tracked in
[issues](https://github.com/Roy-Wanyoike/bridge/issues)) build on the same
typed surface: gRPC-style HTTP/2 + Connect, native gRPC mapping, and
WebSocket/queue bindings for event streams. Because the typed surface and
error model are transport-independent, adding a transport does not change
handler signatures.
