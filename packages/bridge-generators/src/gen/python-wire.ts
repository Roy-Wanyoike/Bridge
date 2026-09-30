/**
 * Python emission for the shared Bridge wire contract (docs/EVENTS.md +
 * docs/RPC.md), matching the TypeScript and Go generators byte-for-byte on
 * the wire:
 *
 * - CloudEvents-style event envelope:
 *   `{"specversion": "1.0", "id": <uuid>, "source": <string>,
 *     "type": "<package>.<EventName>", "time": <RFC3339>, "data": {...}}`.
 *   `id`, `source` and `time` are ALWAYS caller-supplied — generated code
 *   contains no clocks and no uuid generation (determinism).
 * - JSON-over-HTTP RPC server: POST `/{package}/{Service}/{Method}`,
 *   errors as `{"code": string, "message": string}` with the canonical
 *   error-code → HTTP-status mapping; request validators run before the
 *   handler implementation.
 */
import type { GeneratedFile, GeneratorInput } from './input';
import {
  camelToScreamingSnake,
  camelToLowerSnake,
} from '../naming';
import {
  pythonDocstring,
  pythonFieldComment,
} from '../docs';
import { fileHeader } from '../header';
import { generatedFile, joinBlocks } from '../util';
import {
  deserializeExpr,
  pyField,
  pythonDecodeExpr,
  pythonFieldType,
  serializeExpr,
} from './python';
import { renderTypeRef } from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes } from '../analysis';
import {
  ENVELOPE_SPECVERSION,
  eventTypeName,
  RPC_ERROR_CODES_SORTED,
  RPC_ERROR_STATUS,
} from '../wire';
import type { IREvent, IRService } from '@bridge/core';

/* ------------------------------------------------------------------ */
/* events.py — CloudEvents-style envelope, publisher, dispatcher       */
/* ------------------------------------------------------------------ */

/** Generates the upgraded events module for an IR package. */
export function pythonEventsFileV2(
  input: GeneratorInput,
  module: string,
): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  const blocks: string[] = [];

  blocks.push(
    [
      '"""Event payloads and the CloudEvents-style Bridge envelope.',
      '',
      'Envelope wire format:',
      '  {"specversion": "1.0", "id": <uuid>, "source": <string>,',
      '   "type": "<package>.<Event>", "time": <RFC3339>, "data": {...}}.',
      '',
      'id, source and time are ALWAYS caller-supplied: generated code contains',
      'no clocks and no uuid generation (byte-deterministic output).',
      '"""',
    ].join('\n'),
  );
  blocks.push('from __future__ import annotations');
  blocks.push('');
  blocks.push('import json');
  blocks.push('from dataclasses import dataclass');
  blocks.push('from typing import Any, Callable');
  blocks.push('');
  const hasEnums = sortedTypes(input.ir).some((t) => t.kind === 'enum');
  blocks.push(`from .models import *  # noqa: F401,F403`);
  if (hasEnums) blocks.push(`from .enums import *  # noqa: F401,F403`);

  blocks.push(
    [
      '',
      `BRIDGE_EVENT_SPECVERSION = ${JSON.stringify(ENVELOPE_SPECVERSION)}`,
      '',
      '',
      '@dataclass',
      'class BridgeEventMeta:',
      '    """Caller-supplied envelope metadata (id, source, time)."""',
      '',
      '    id: str',
      '    source: str',
      '    time: str',
      '',
      '',
      'def decode_bridge_event_envelope(data: "dict[str, Any]") -> "dict[str, Any]":',
      '    """Validate the envelope shape; returns the envelope untouched."""',
      '    if not isinstance(data, dict):',
      '        raise ValueError("bridge event envelope: expected object")',
      '    if data.get("specversion") != BRIDGE_EVENT_SPECVERSION:',
      '        raise ValueError(',
      '            f"bridge event envelope: unsupported specversion {data.get(\'specversion\')!r}"',
      '        )',
      '    for key in ("id", "source", "type", "time"):',
      '        if not isinstance(data.get(key), str):',
      '            raise ValueError(f"bridge event envelope: expected string {key!r}")',
      '    return data',
      '',
      '',
      'class EventPublisher:',
      '    """Generic event publisher; the transport builds the envelope."""',
      '',
      '    def publish(self, type_: str, payload: Any, meta: BridgeEventMeta) -> None:',
      '        raise NotImplementedError',
      '',
      '',
      'class InMemoryEventBus(EventPublisher):',
      '    """Hands envelopes to per-type subscribers; ideal for tests and',
      '    in-process wiring. Swap for a real transport in production."""',
      '',
      '    def __init__(self) -> None:',
      '        self._subscribers: "dict[str, list[Callable[[dict[str, Any]], Any]]]" = {}',
      '',
      '    def subscribe(self, type_: str, subscriber: "Callable[[dict[str, Any]], Any]") -> "Callable[[], None]":',
      '        self._subscribers.setdefault(type_, []).append(subscriber)',
      '',
      '        def unsubscribe() -> None:',
      '            current = self._subscribers.get(type_, [])',
      '            if subscriber in current:',
      '                current.remove(subscriber)',
      '',
      '        return unsubscribe',
      '',
      '    def publish(self, type_: str, payload: Any, meta: BridgeEventMeta) -> None:',
      '        envelope = {',
      '            "specversion": BRIDGE_EVENT_SPECVERSION,',
      '            "id": meta.id,',
      '            "source": meta.source,',
      '            "type": type_,',
      '            "time": meta.time,',
      '            "data": payload,',
      '        }',
      '        for subscriber in list(self._subscribers.get(type_, [])):',
      '            subscriber(envelope)',
      '',
      '',
      'class BridgeEventDispatcher:',
      '    """Routes envelopes (dicts or JSON text) to per-event handlers by',
      '    their `type`. Raises ValueError on malformed envelopes and KeyError',
      '    when no handler is registered for the type."""',
      '',
      '    def __init__(self) -> None:',
      '        self._handlers: "dict[str, list[Callable[[Any, BridgeEventMeta], Any]]]" = {}',
      '',
      '    def dispatch(self, data: "dict[str, Any]") -> None:',
      '        envelope = decode_bridge_event_envelope(data)',
      '        type_ = envelope["type"]',
      '        handlers = self._handlers.get(type_)',
      '        if not handlers:',
      '            raise KeyError(f"no handler registered for event type {type_!r}")',
      '        meta = BridgeEventMeta(',
      '            id=envelope["id"],',
      '            source=envelope["source"],',
      '            time=envelope["time"],',
      '        )',
      '        for handler in list(handlers):',
      '            handler(envelope["data"], meta)',
      '',
      '    def dispatch_json(self, text: str) -> None:',
      '        self.dispatch(json.loads(text))',
    ].join('\n'),
  );

  for (const event of events) {
    blocks.push(renderEventPayload(event, input));
  }

  blocks.push(
    [
      '',
      'def _no_handler(type_: str) -> None:',
      '    raise KeyError(f"no handler registered for event type {type_!r}")',
    ].join('\n'),
  );

  const content = [fileHeader('python', input.packageName), joinBlocks(blocks), ''].join('\n');
  return generatedFile(`${module}/events.py`, content);
}

/** One event: payload dataclass + type const + publisher + encode/decode. */
function renderEventPayload(event: IREvent, input: GeneratorInput): string {
  const lines: string[] = [];
  const snake = camelToLowerSnake(event.name);
  const typeConst = `${camelToScreamingSnake(event.name)}_TYPE`;
  const fqType = eventTypeName(input.packageName, event.name);

  lines.push('');
  lines.push('');
  lines.push('@dataclass');
  lines.push(`class ${event.name}:`);
  const doc = pythonDocstring(event.docs, undefined);
  lines.push(doc ?? `    """${event.name} event payload."""`);

  const required = event.fields.filter((f) => !f.optional);
  const defaulted = event.fields.filter((f) => f.optional);
  const ordered = [...required, ...defaulted];
  for (const field of ordered) {
    const comment = pythonFieldComment(field.docs, field.deprecated);
    if (comment !== undefined) lines.push(comment);
    const defaultPart = field.optional ? ' = None' : '';
    lines.push(`    ${pyField(field)}: ${pythonFieldType(field, input)}${defaultPart}`);
  }

  lines.push('');
  lines.push('    def to_dict(self) -> "dict[str, Any]":');
  lines.push('        out: "dict[str, Any]" = {}');
  for (const field of event.fields) {
    const key = JSON.stringify(field.name);
    const expr = serializeExpr(field.type, `self.${pyField(field)}`, input);
    if (field.optional) {
      lines.push(`        if self.${pyField(field)} is not None:`);
      lines.push(`            out[${key}] = ${expr}`);
    } else {
      lines.push(`        out[${key}] = ${expr}`);
    }
  }
  lines.push('        return out');

  lines.push('');
  lines.push('    @classmethod');
  // Decoder parameter is `raw_data` (not `data`): a payload field named
  // `data` used to rebind the parameter mid-decode (issue #115). The name
  // is in PYTHON_RESERVED_MEMBERS, so fields cannot take it either.
  lines.push(`    def from_dict(cls, raw_data: "dict[str, Any]") -> "${event.name}":`);
  for (const field of event.fields) {
    const key = JSON.stringify(field.name);
    if (field.optional) {
      lines.push(`        ${pyField(field)} = ${deserializeExpr(field.type, `raw_data.get(${key})`, input, true)}`);
    } else {
      lines.push(`        if raw_data.get(${key}) is None:`);
      lines.push(`            raise ValueError("Missing required field ${field.name} for ${event.name}")`);
      lines.push(`        ${pyField(field)} = ${deserializeExpr(field.type, `raw_data.get(${key})`, input, false)}`);
    }
  }
  lines.push('        return cls(');
  for (const field of event.fields) {
    lines.push(`            ${pyField(field)}=${pyField(field)},`);
  }
  lines.push('        )');

  lines.push('');
  lines.push(`${typeConst} = ${JSON.stringify(fqType)}`);
  lines.push('');
  lines.push(`${event.name}Handler = "Callable[[${event.name}, BridgeEventMeta], Any]"`);
  lines.push('');
  lines.push(`class ${event.name}Publisher:`);
  lines.push(`    """Typed publisher for ${event.name} events."""`);
  lines.push('');
  lines.push(`    def publish(self, event: ${event.name}, meta: BridgeEventMeta) -> None:`);
  lines.push('        raise NotImplementedError');
  lines.push('');
  lines.push('');
  lines.push(`def create_${snake}_publisher(publisher: EventPublisher) -> ${event.name}Publisher:`);
  lines.push(`    """Build a typed ${event.name}Publisher on top of any generic publisher."""`);
  lines.push(`    class _Typed${event.name}Publisher(${event.name}Publisher):`);
  lines.push('        def publish(self, event: "' + `${event.name}` + '", meta: BridgeEventMeta) -> None:');
  lines.push(`            publisher.publish(${typeConst}, event.to_dict(), meta)`);
  lines.push(`    return _Typed${event.name}Publisher()`);
  lines.push('');
  lines.push('');
  lines.push(`def encode_${snake}(data: ${event.name}, meta: BridgeEventMeta) -> "dict[str, Any]":`);
  lines.push(`    """Wrap a ${event.name} into the CloudEvents-style Bridge envelope."""`);
  lines.push('    return {');
  lines.push('        "specversion": BRIDGE_EVENT_SPECVERSION,');
  lines.push('        "id": meta.id,');
  lines.push('        "source": meta.source,');
  lines.push(`        "type": ${typeConst},`);
  lines.push('        "time": meta.time,');
  lines.push('        "data": data.to_dict(),');
  lines.push('    }');
  lines.push('');
  lines.push('');
  lines.push(`def decode_${snake}(data: "dict[str, Any]") -> "tuple[${event.name}, BridgeEventMeta]":`);
  lines.push(`    """Decode a ${event.name} envelope; verifies specversion and the type."""`);
  lines.push('    envelope = decode_bridge_event_envelope(data)');
  lines.push(`    if envelope["type"] != ${typeConst}:`);
  lines.push(`        raise ValueError(f"${event.name} envelope: unexpected type {envelope['type']!r}")`);
  lines.push('    meta = BridgeEventMeta(');
  lines.push('        id=envelope["id"],');
  lines.push('        source=envelope["source"],');
  lines.push('        time=envelope["time"],');
  lines.push('    )');
  lines.push(`    return ${event.name}.from_dict(envelope["data"]), meta`);
  lines.push('');
  lines.push('');
  lines.push(`def register_${snake}(dispatcher: BridgeEventDispatcher, handler: "${event.name}Handler") -> BridgeEventDispatcher:`);
  lines.push(`    """Register a ${event.name} handler; the payload is decoded to ${event.name} first."""`);
  lines.push('    def _decoded(data: "dict[str, Any]", meta: BridgeEventMeta) -> None:');
  lines.push(`        handler(${event.name}.from_dict(data), meta)`);
  lines.push('    dispatcher._handlers.setdefault(' + `${typeConst}` + ', []).append(_decoded)  # noqa: SLF001');
  lines.push('    return dispatcher');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* services.py — server side                                           */
/* ------------------------------------------------------------------ */

/**
 * Emits the server-side half of services.py: the error-code table,
 * `BridgeRpcError`, a handler protocol and a stdlib `http.server` binding
 * per service. Returns the extra blocks appended after the clients.
 */
export function pythonServerBlocks(input: GeneratorInput): string[] {
  const blocks: string[] = [];

  blocks.push(
    [
      '',
      'BRIDGE_ERROR_STATUS: "dict[str, int]" = {',
      ...RPC_ERROR_CODES_SORTED.map((code) => `    ${JSON.stringify(code)}: ${String(RPC_ERROR_STATUS[code])},`),
      '}',
      '',
      '',
      'def bridge_status_for_code(code: str) -> int:',
      '    """HTTP status for a Bridge RPC error code; unknown codes map to 500."""',
      '    return BRIDGE_ERROR_STATUS.get(code, 500)',
      '',
      '',
      'class BridgeRpcError(Exception):',
      '    """Raise from a handler implementation to control the error response."""',
      '',
      '    def __init__(self, code: str, message: str) -> None:',
      '        super().__init__(f"bridge rpc error {code}: {message}")',
      '        self.code = code',
      '        self.message = message',
    ].join('\n'),
  );

  const localStructs = new Set(
    sortedTypes(input.ir)
      .filter((t) => t.kind === 'struct')
      .map((t) => t.name),
  );

  for (const service of sortedServices(input.ir)) {
    blocks.push(renderServiceServer(service, input, localStructs));
  }
  return blocks;
}

function renderServiceServer(
  service: IRService,
  input: GeneratorInput,
  localStructs: ReadonlySet<string>,
): string {
  const lines: string[] = [];
  const snakeService = camelToLowerSnake(service.name);
  const routePrefix = `/${input.packageName}/${service.name}/`;

  lines.push('');
  lines.push('');
  lines.push(`class ${service.name}ServiceHandler:`);
  lines.push(`    """Implement this protocol to serve the ${service.name} service."""`);
  for (const method of service.methods) {
    // Signatures render through the type table so cross-package (opaque)
    // and alias-substituted method types stay decodable/annotatable.
    const inputType = renderTypeRef(method.input, input.render);
    const outputType = renderTypeRef(method.output, input.render);
    lines.push('');
    lines.push(`    def ${camelToLowerSnake(method.name)}(self, request: ${inputType}) -> ${outputType}:`);
    lines.push('        raise NotImplementedError');
  }

  lines.push('');
  lines.push('');
  lines.push(
    `def make_${snakeService}_handler(handler: "${service.name}ServiceHandler") -> "type[BaseHTTPRequestHandler]":`,
  );
  lines.push(`    """Bind a ${service.name}ServiceHandler to the Bridge JSON-over-HTTP wire shape`,
    `    (POST ${routePrefix}<Method>) as a BaseHTTPRequestHandler class for`,
    `    http.server. Malformed requests become 400 invalid_argument;`,
    `    BridgeRpcError maps code → status; anything else is 500."""`);
  lines.push(`    route_prefix = ${JSON.stringify(routePrefix)}`);
  lines.push('    # DoS guard: maximum request body size decoded by generated servers.');
  lines.push('    bridge_max_body_bytes = 1 << 20');
  lines.push('');
  lines.push('    BRIDGE_MAX_BODY_BYTES = bridge_max_body_bytes');
  lines.push('');
  lines.push('    class BridgeHandler(BaseHTTPRequestHandler):');
  lines.push('        """Routes POST <prefix><Method> to the handler implementation."""');
  lines.push('');
  lines.push('        def _send_json(self, status: int, body: "dict[str, Any]") -> None:');
  lines.push('            raw = json.dumps(body).encode("utf-8")');
  lines.push('            self.send_response(status)');
  lines.push('            self.send_header("Content-Type", "application/json")');
  lines.push('            self.send_header("Content-Length", str(len(raw)))');
  lines.push('            self.end_headers()');
  lines.push('            self.wfile.write(raw)');
  lines.push('');
  lines.push('        def _send_bridge_error(self, code: str, message: str) -> None:');
  lines.push('            self._send_json(bridge_status_for_code(code), {"code": code, "message": message})');
  lines.push('');
  lines.push('        def do_POST(self) -> None:  # noqa: N802 (stdlib name)');
  lines.push('            path = self.path.split("?", 1)[0]');
  lines.push('            if not path.startswith(route_prefix):');
  lines.push('                self._send_bridge_error("not_found", f"unknown route {path!r}")');
  lines.push('                return');
  lines.push('            method_name = path[len(route_prefix):]');
  lines.push('            length = int(self.headers.get("Content-Length") or 0)');
  lines.push('            # DoS guard: reject oversized declared bodies before reading (issue #45).');
  lines.push('            if length > BRIDGE_MAX_BODY_BYTES:');
  lines.push('                self._send_bridge_error("payload_too_large", "request body exceeds the 1 MiB limit")');
  lines.push('                return');
  lines.push('            raw = self.rfile.read(length) if length > 0 else b""');
  lines.push('            try:');
  lines.push('                parsed = json.loads(raw.decode("utf-8"))');
  lines.push('            except (ValueError, UnicodeDecodeError) as exc:');
  lines.push('                self._send_bridge_error("invalid_argument", f"decode request: {exc}")');
  lines.push('                return');
  lines.push('            self._dispatch(method_name, parsed)');
  lines.push('');
  lines.push('        def do_GET(self) -> None:  # noqa: N802 (stdlib name)');
  lines.push('            self._send_bridge_error("method_not_allowed", "Bridge RPC routes accept POST only")');
  lines.push('');
  lines.push('        def _dispatch(self, method_name: str, parsed: "Any") -> None:');
  lines.push('            try:');
  for (const method of service.methods) {
    // Request decode degrades to passthrough for opaque cross-package
    // inputs; validation only applies to local struct inputs (same guard
    // as the Go/TS generators' validator tables).
    const ref = method.input.kind === 'optional' ? method.input.inner : method.input;
    const isLocalStruct =
      ref.kind === 'named' &&
      !(ref.package !== undefined && ref.package !== input.ir.name) &&
      localStructs.has(ref.name);
    lines.push(`                if method_name == ${JSON.stringify(method.name)}:`);
    lines.push(
      `                    request = ${pythonDecodeExpr(method.input, input, 'parsed')}`,
    );
    if (isLocalStruct && ref.kind === 'named') {
      lines.push(`                    violations = validate_${ref.name}(request)`);
      lines.push('                    if violations:');
      lines.push('                        self._send_bridge_error("invalid_argument", "; ".join(violations))');
      lines.push('                        return');
    }
    lines.push(`                    result = handler.${camelToLowerSnake(method.name)}(request)`);
    lines.push(`                    self._send_json(200, ${serializeExpr(method.output, 'result', input)})`);
    lines.push('                    return');
  }
  lines.push('                self._send_bridge_error("not_found", f"unknown method {method_name!r}")');
  lines.push('            except BridgeRpcError as exc:');
  lines.push('                self._send_bridge_error(exc.code, exc.message)');
  lines.push('            except (ValueError, KeyError, TypeError) as exc:');
  lines.push('                self._send_bridge_error("invalid_argument", str(exc))');
  lines.push('            except Exception as exc:  # noqa: BLE001 — last-resort 500');
  lines.push('                self._send_bridge_error("internal", str(exc))');
  lines.push('');
  lines.push('        def log_message(self, format: str, *args: "Any") -> None:');
  lines.push('            pass  # keep test output quiet');
  lines.push('');
  lines.push('    return BridgeHandler');
  return lines.join('\n');
}
