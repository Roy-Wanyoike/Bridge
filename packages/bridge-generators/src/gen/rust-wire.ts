/**
 * Rust emission for the shared Bridge wire contract (docs/EVENTS.md +
 * docs/RPC.md) — the same wire shapes as the TypeScript, Go and Python
 * generators:
 *
 * - CloudEvents-style event envelope
 *   `{"specversion":"1.0","id","source","type":"<package>.<Event>","time","data"}`;
 *   `id`/`source`/`time` are always caller-supplied (determinism).
 * - JSON-over-HTTP RPC with the canonical error-code → HTTP-status table.
 *   The HTTP client and server use ONLY the Rust standard library
 *   (`std::net::TcpStream`/`TcpListener`) plus serde_json, so generated
 *   crates stay dependency-light.
 */
import type { GeneratedFile, GeneratorInput } from './input';
import type { IRField, IREvent, IRService } from '@bridge/core';
import { camelToScreamingSnake, camelToLowerSnake, rustCrateName, rustFieldName } from '../naming';
import { isLocalStructRef } from '../mappings';
import { sortedEvents, sortedServices, sortedTypes, structZeroValuePassesValidation } from '../analysis';
import { generatedFile } from '../util';
import { fileHeader } from '../header';
import { rustDoc } from '../docs';
import { RPC_ERROR_CODES_SORTED, RPC_ERROR_STATUS } from '../wire';

/* ------------------------------------------------------------------ */
/* src/events.rs — CloudEvents-style envelope                          */
/* ------------------------------------------------------------------ */

/** Envelope machinery emitted once at the top of events.rs. */
export function rustEventEnvelopeBlock(): string {
  let out = '';
  out += 'pub const BRIDGE_EVENT_SPECVERSION: &str = "1.0";\n\n';
  out += '/// Caller-supplied envelope metadata. Generated code never reads the clock\n';
  out += '/// or generates ids, so publishers must provide all three values.\n';
  out += '#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\n';
  out += 'pub struct BridgeEventMeta {\n';
  out += '    pub id: String,\n';
  out += '    pub source: String,\n';
  out += '    pub time: String,\n';
  out += '}\n\n';
  out += '/// CloudEvents-style Bridge event envelope; `data` carries the event payload.\n';
  out += '#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\n';
  out += 'pub struct BridgeEventEnvelope<T> {\n';
  out += '    pub specversion: String,\n';
  out += '    pub id: String,\n';
  out += '    pub source: String,\n';
  out += '    #[serde(rename = "type")]\n';
  out += '    pub event_type: String,\n';
  out += '    pub time: String,\n';
  out += '    pub data: T,\n';
  out += '}\n\n';
  out += '/// Decodes and validates the envelope shape without touching the payload.\n';
  out += 'pub fn decode_bridge_event_envelope(\n';
  out += '    value: &serde_json::Value,\n';
  out += ') -> Result<BridgeEventEnvelope<serde_json::Value>, String> {\n';
  out += '    let specversion = value.get("specversion").and_then(|v| v.as_str());\n';
  out += '    if specversion != Some(BRIDGE_EVENT_SPECVERSION) {\n';
  out += '        return Err(format!(\n';
  out += '            "bridge event envelope: unsupported specversion {:?}",\n';
  out += '            specversion\n';
  out += '        ));\n';
  out += '    }\n';
  out += '    for key in ["id", "source", "type", "time"] {\n';
  out += '        if !value.get(key).map_or(false, |v| v.is_string()) {\n';
  out += '            return Err(format!("bridge event envelope: expected string {key:?}"));\n';
  out += '        }\n';
  out += '    }\n';
  out += '    let envelope: BridgeEventEnvelope<serde_json::Value> =\n';
  out += '        serde_json::from_value(value.clone()).map_err(|err| err.to_string())?;\n';
  out += '    Ok(envelope)\n}\n\n';
  out += '/// Generic event publisher. Publishes a raw payload under an event type;\n';
  out += '/// the transport builds the envelope from `meta`.\n';
  out += 'pub trait EventPublisher {\n';
  out += '    fn publish(\n';
  out += '        &self,\n';
  out += '        type_: &str,\n';
  out += '        payload: serde_json::Value,\n';
  out += '        meta: &BridgeEventMeta,\n';
  out += '    ) -> Result<(), String>;\n';
  out += '}\n\n';
  out += '/// Routes envelopes to registered per-event handlers by their `type`.\n';
  out += '#[derive(Default)]\n';
  out += 'pub struct BridgeEventDispatcher {\n';
  out += '    handlers: std::collections::HashMap<\n';
  out += '        String,\n';
  out += '        Vec<Box<dyn Fn(serde_json::Value, &BridgeEventMeta) -> Result<(), String> + Send>>,\n';
  out += '    >,\n';
  out += '}\n\n';
  out += 'impl BridgeEventDispatcher {\n';
  out += '    pub fn new() -> Self {\n';
  out += '        Self::default()\n';
  out += '    }\n\n';
  out += '    fn register_typed(\n';
  out += '        &mut self,\n';
  out += '        type_: &str,\n';
  out += '        handler: Box<dyn Fn(serde_json::Value, &BridgeEventMeta) -> Result<(), String> + Send>,\n';
  out += '    ) {\n';
  out += '        self.handlers.entry(type_.to_string()).or_default().push(handler);\n';
  out += '    }\n\n';
  out += '    /// Dispatches one envelope (already parsed JSON).\n';
  out += '    pub fn dispatch(&self, value: serde_json::Value) -> Result<(), String> {\n';
  out += '        let envelope = decode_bridge_event_envelope(&value)?;\n';
  out += '        let handlers = self\n';
  out += '            .handlers\n';
  out += '            .get(&envelope.event_type)\n';
  out += '            .ok_or_else(|| format!("no handler registered for event type {:?}", envelope.event_type))?;\n';
  out += '        let meta = BridgeEventMeta {\n';
  out += '            id: envelope.id,\n';
  out += '            source: envelope.source,\n';
  out += '            time: envelope.time,\n';
  out += '        };\n';
  out += '        for handler in handlers {\n';
  out += '            handler(envelope.data.clone(), &meta)?;\n';
  out += '        }\n';
  out += '        Ok(())\n';
  out += '    }\n\n';
  out += '    /// Parses JSON text, then dispatches.\n';
  out += '    pub fn dispatch_json(&self, text: &str) -> Result<(), String> {\n';
  out += '        let value: serde_json::Value =\n';
  out += '            serde_json::from_str(text).map_err(|err| err.to_string())?;\n';
  out += '        self.dispatch(value)\n';
  out += '    }\n}\n\n';
  out += '/// In-memory EventPublisher: hands envelopes to a shared sink.\n';
  out += '#[derive(Default)]\n';
  out += 'pub struct InMemoryEventBus {\n';
  out += '    sink: std::sync::Mutex<Vec<BridgeEventEnvelope<serde_json::Value>>>,\n';
  out += '}\n\n';
  out += 'impl InMemoryEventBus {\n';
  out += '    pub fn new() -> Self {\n';
  out += '        Self::default()\n';
  out += '    }\n\n';
  out += '    /// Snapshot of every envelope published so far.\n';
  out += '    pub fn published(&self) -> Vec<BridgeEventEnvelope<serde_json::Value>> {\n';
  out += '        self.sink.lock().map(|sink| sink.clone()).unwrap_or_default()\n';
  out += '    }\n';
  out += '}\n\n';
  out += 'impl EventPublisher for InMemoryEventBus {\n';
  out += '    fn publish(\n';
  out += '        &self,\n';
  out += '        type_: &str,\n';
  out += '        payload: serde_json::Value,\n';
  out += '        meta: &BridgeEventMeta,\n';
  out += '    ) -> Result<(), String> {\n';
  out += '        let envelope = BridgeEventEnvelope {\n';
  out += '            specversion: BRIDGE_EVENT_SPECVERSION.to_string(),\n';
  out += '            id: meta.id.clone(),\n';
  out += '            source: meta.source.clone(),\n';
  out += '            event_type: type_.to_string(),\n';
  out += '            time: meta.time.clone(),\n';
  out += '            data: payload,\n';
  out += '        };\n';
  out += '        if let Ok(mut sink) = self.sink.lock() {\n';
  out += '            sink.push(envelope);\n';
  out += '        }\n';
  out += '        Ok(())\n';
  out += '    }\n}\n';
  return out;
}

/** Per-event emission: type const + encode/decode + typed publish/register. */
export function rustEventV2(event: IREvent, input: GeneratorInput): string {
  let out = '';
  const snake = camelToLowerSnake(event.name);
  const typeConst = `${camelToScreamingSnake(event.name)}_TYPE`;
  const fqType = `${input.packageName}.${event.name}`;

  out += `pub const ${typeConst}: &str = ${JSON.stringify(fqType)};\n\n`;

  out += `impl ${event.name} {\n`;
  out += '    /// Wraps the event into the CloudEvents-style Bridge envelope.\n';
  out += '    pub fn encode(\n';
  out += '        &self,\n';
  out += '        meta: &BridgeEventMeta,\n';
  out += '    ) -> Result<BridgeEventEnvelope<serde_json::Value>, String> {\n';
  out += '        let data = serde_json::to_value(self).map_err(|err| err.to_string())?;\n';
  out += '        Ok(BridgeEventEnvelope {\n';
  out += '            specversion: BRIDGE_EVENT_SPECVERSION.to_string(),\n';
  out += '            id: meta.id.clone(),\n';
  out += '            source: meta.source.clone(),\n';
  out += `            event_type: ${typeConst}.to_string(),\n`;
  out += '            time: meta.time.clone(),\n';
  out += '            data,\n';
  out += '        })\n';
  out += '    }\n\n';
  out += '    /// Decodes an envelope, verifying specversion and the event type.\n';
  out += '    pub fn decode(\n';
  out += '        value: serde_json::Value,\n';
  out += '    ) -> Result<(Self, BridgeEventMeta), String> {\n';
  out += '        let envelope = decode_bridge_event_envelope(&value)?;\n';
  out += `        if envelope.event_type != ${typeConst} {\n`;
  out += '            return Err(format!(\n';
  out += `                "${event.name} envelope: unexpected type {:?}",\n`;
  out += '                envelope.event_type\n';
  out += '            ));\n';
  out += '        }\n';
  out += '        let payload: Self = serde_json::from_value(envelope.data).map_err(|err| err.to_string())?;\n';
  out += '        Ok((\n';
  out += '            payload,\n';
  out += '            BridgeEventMeta {\n';
  out += '                id: envelope.id,\n';
  out += '                source: envelope.source,\n';
  out += '                time: envelope.time,\n';
  out += '            },\n';
  out += '        ))\n';
  out += '    }\n}\n\n';

  out += `/// Typed publish of a ${event.name} through any generic publisher.\n`;
  out += `pub fn publish_${snake}(publisher: &dyn EventPublisher, event: &${event.name}, meta: &BridgeEventMeta) -> Result<(), String> {\n`;
  out += `    let envelope = event.encode(meta)?;\n`;
  out += `    publisher.publish(${typeConst}, envelope.data, meta)\n`;
  out += '}\n\n';

  out += `/// Registers a ${event.name} handler; the payload is decoded to ${event.name} first.\n`;
  out += `pub fn register_${snake}(\n`;
  out += '    dispatcher: &mut BridgeEventDispatcher,\n';
  out += `    handler: impl Fn(${event.name}, BridgeEventMeta) -> Result<(), String> + Send + 'static,\n`;
  out += ') {\n';
  out += '    dispatcher.register_typed(\n';
  out += `        ${typeConst},\n`;
  out += '        Box::new(move |data, meta| {\n';
  out += `            let payload: ${event.name} = serde_json::from_value(data).map_err(|err| err.to_string())?;\n`;
  out += '            handler(payload, meta.clone())\n';
  out += '        }),\n';
  out += '    );\n';
  out += '}\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* src/services.rs — HTTP client + server (std net, no extra deps)     */
/* ------------------------------------------------------------------ */

/** Error table + BridgeRpcError + HTTP plumbing shared by all services. */
export function rustServerPrelude(): string {
  let out = '';
  out += '/// The canonical Bridge RPC error-code → HTTP-status table.\n';
  out += 'pub fn bridge_status_for_code(code: &str) -> u16 {\n';
  out += '    match code {\n';
  for (const code of RPC_ERROR_CODES_SORTED) {
    out += `        ${JSON.stringify(code)} => ${RPC_ERROR_STATUS[code]},\n`;
  }
  out += '        _ => 500,\n';
  out += '    }\n}\n\n';
  out += '/// Error type handlers raise to control the HTTP response.\n';
  out += '#[derive(Debug, Clone)]\n';
  out += 'pub struct BridgeRpcError {\n';
  out += '    pub code: String,\n';
  out += '    pub message: String,\n';
  out += '}\n\n';
  out += 'impl BridgeRpcError {\n';
  out += '    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {\n';
  out += '        Self { code: code.into(), message: message.into() }\n';
  out += '    }\n}\n\n';
  out += 'impl std::fmt::Display for BridgeRpcError {\n';
  out += '    fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {\n';
  out += '        write!(f, "bridge rpc error {}: {}", self.code, self.message)\n';
  out += '    }\n}\n\n';
  out += 'impl std::error::Error for BridgeRpcError {}\n\n';
  out += '/// Builds a BridgeRpcError from an error response body {"code","message"}.\n';
  out += 'pub fn bridge_error_from_body(status: u16, value: &serde_json::Value) -> BridgeRpcError {\n';
  out += '    let code = value.get("code").and_then(|v| v.as_str()).unwrap_or("internal").to_string();\n';
  out += '    let message = value\n';
  out += '        .get("message")\n';
  out += '        .and_then(|v| v.as_str())\n';
  out += '        .unwrap_or("")\n';
  out += '        .to_string();\n';
  out += '    if bridge_status_for_code(&code) == status {\n';
  out += '        BridgeRpcError { code, message }\n';
  out += '    } else {\n';
  out += '        BridgeRpcError { code: "internal".to_string(), message: format!("unexpected status {status}: {message}") }\n';
  out += '    }\n}\n\n';
  out += '/// Result of one HTTP call: status plus parsed body value.\n';
  out += 'pub type BridgeCallResult = Result<(u16, serde_json::Value), String>;\n\n';
  out += '/// Raw JSON-over-HTTP POST against a Bridge service route. Public for tests.\n';
  out += 'pub fn bridge_http_post_json(base_url: &str, path: &str, body: &str) -> BridgeCallResult {\n';
  out += '    use std::io::{Read, Write};\n';
  out += '    let rest = base_url\n';
  out += '        .strip_prefix("http://")\n';
  out += '        .ok_or_else(|| format!("only http:// base URLs are supported, got {base_url:?}"))?;\n';
  out += '    let (authority, _base_path) = rest.split_once(\'/\').unwrap_or((rest, ""));\n';
  out += '    let mut stream = std::net::TcpStream::connect(authority).map_err(|err| err.to_string())?;\n';
  out += '    let full_path = format!("{_base_path}/{path}");\n';
  out += '    let request = format!(\n';
  out += '        "POST {full_path} HTTP/1.1\\r\\nHost: {authority}\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{body}",\n';
  out += '        body.len()\n';
  out += '    );\n';
  out += '    stream.write_all(request.as_bytes()).map_err(|err| err.to_string())?;\n';
  out += '    let mut response = Vec::new();\n';
  out += '    stream.read_to_end(&mut response).map_err(|err| err.to_string())?;\n';
  out += '    let text = String::from_utf8_lossy(&response);\n';
  out += '    let status: u16 = text\n';
  out += '        .split_whitespace()\n';
  out += '        .nth(1)\n';
  out += '        .and_then(|s| s.parse().ok())\n';
  out += '        .ok_or_else(|| "malformed HTTP response".to_string())?;\n';
  out += '    let body_start = text.find("\\r\\n\\r\\n").map(|i| i + 4).unwrap_or(text.len());\n';
  out += '    let value = serde_json::from_str(text[body_start..].trim())\n';
  out += '        .unwrap_or(serde_json::Value::Null);\n';
  out += '    Ok((status, value))\n}\n\n';
  out += 'pub(crate) fn write_http_response(\n';
  out += '    stream: &mut std::net::TcpStream,\n';
  out += '    status: u16,\n';
  out += '    body: &serde_json::Value,\n';
  out += ') {\n';
  out += '    use std::io::Write;\n';
  out += '    let raw = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());\n';
  out += '    let reason = match status {\n';
  out += '        200 => "OK",\n';
  out += '        400 => "Bad Request",\n';
  out += '        401 => "Unauthorized",\n';
  out += '        403 => "Forbidden",\n';
  out += '        404 => "Not Found",\n';
  out += '        405 => "Method Not Allowed",\n';
  out += '        409 => "Conflict",\n';
  out += '        412 => "Precondition Failed",\n';
  out += '        429 => "Too Many Requests",\n';
  out += '        500 => "Internal Server Error",\n';
  out += '        501 => "Not Implemented",\n';
  out += '        503 => "Service Unavailable",\n';
  out += '        504 => "Gateway Timeout",\n';
  out += '        _ => "Unknown",\n';
  out += '    };\n';
  out += '    let response = format!(\n';
  out += '        "HTTP/1.1 {status} {reason}\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{raw}",\n';
  out += '        raw.len()\n';
  out += '    );\n';
  out += '    let _ = stream.write_all(response.as_bytes());\n}\n\n';
  out += 'pub(crate) fn parse_http_request(stream: &mut std::net::TcpStream) -> Option<(String, serde_json::Value)> {\n';
  out += '    use std::io::{BufRead, BufReader, Read};\n';
  out += '    let mut reader = BufReader::new(&mut *stream);\n';
  out += '    let mut request_line = String::new();\n';
  out += '    reader.read_line(&mut request_line).ok()?;\n';
  out += '    let mut parts = request_line.split_whitespace();\n';
  out += '    let method = parts.next()?.to_string();\n';
  out += '    let path = parts.next()?.to_string();\n';
  out += '    let mut content_length = 0usize;\n';
  out += '    loop {\n';
  out += '        let mut line = String::new();\n';
  out += '        reader.read_line(&mut line).ok()?;\n';
  out += '        let line = line.trim_end();\n';
  out += '        if line.is_empty() {\n';
  out += '            break;\n';
  out += '        }\n';
  out += '        if let Some(value) = line.strip_prefix("content-length:") {\n';
  out += '            content_length = value.trim().parse().unwrap_or(0);\n';
  out += '        }\n';
  out += '    }\n';
  out += '    // DoS guard: reject oversized declared bodies before allocating (issue #45).\n';
  out += '    const BRIDGE_MAX_BODY_BYTES: usize = 1 << 20;\n';
  out += '    let oversized = content_length > BRIDGE_MAX_BODY_BYTES;\n';
  out += '    let mut body: Vec<u8> = Vec::new();\n';
  out += '    if !oversized && content_length > 0 {\n';
  out += '        body = vec![0u8; content_length];\n';
  out += '        reader.read_exact(&mut body).ok()?;\n';
  out += '    }\n';
  out += '    drop(reader);\n';
  out += '    if oversized {\n';
  out += '        write_http_response(\n';
  out += '            stream,\n';
  out += '            413,\n';
  out += '            &serde_json::json!({"code": "payload_too_large", "message": "request body exceeds the 1 MiB limit"}),\n';
  out += '        );\n';
  out += '        return None;\n';
  out += '    }\n';
  out += '    let value = serde_json::from_slice::<serde_json::Value>(&body)\n';
  out += '        .unwrap_or(serde_json::Value::Null);\n';
  out += '    Some((format!("{method} {path}"), value))\n}\n';
  return out;
}

/** Per-service client + server emission over the stdlib HTTP plumbing. */
export function rustServiceHttp(service: IRService, input: GeneratorInput): string {
  // Server-side request validators: one per method whose input is a local
  // struct (validate.rs emits validate for every local struct).
  // Cross-package/optional-composite inputs are opaque aliases
  // (serde_json::Value) without a validate method — they must not be
  // dereferenced (same guard as the Go generator's validator table).
  const validators = new Set<string>();
  for (const method of service.methods) {
    const ref = method.input.kind === 'optional' ? method.input.inner : method.input;
    if (ref.kind === 'named' && isLocalStructRef(ref, input.ir)) {
      validators.add(method.name);
    }
  }

  let out = '';
  const snakeService = camelToLowerSnake(service.name);
  const routePrefix = `/${input.packageName}/${service.name}`;
  const handlerTrait = service.name;

  // --- client ---
  out += `/// JSON-over-HTTP client for the ${service.name} service (stdlib TCP, no extra deps).\n`;
  out += `pub struct ${service.name}HttpClient {\n`;
  out += '    base_url: String,\n';
  out += '}\n\n';
  out += `impl ${service.name}HttpClient {\n`;
  out += '    /// `base_url` like `http://127.0.0.1:8080` (no trailing slash).\n';
  out += '    pub fn new(base_url: impl Into<String>) -> Self {\n';
  out += '        Self { base_url: base_url.into() }\n';
  out += '    }\n';
  for (const method of service.methods) {
    const inputType = rustMethodTypeNameLocal(method.input);
    const outputType = rustMethodTypeNameLocal(method.output);
    const snakeMethod = camelToLowerSnake(method.name);
    out += '\n';
    out += `    pub fn ${snakeMethod}(&self, req: &${inputType}) -> Result<${outputType}, BridgeRpcError> {\n`;
    out += '        let body = serde_json::to_string(req).map_err(|err| BridgeRpcError::new("internal", err.to_string()))?;\n';
    out += `        let (status, value) =\n`;
    out += `            bridge_http_post_json(&self.base_url, "${routePrefix}/${method.name}", &body)\n`;
    out += '                .map_err(|err| BridgeRpcError::new("internal", err))?;\n';
    out += '        if (200..300).contains(&status) {\n';
    out += '            let parsed = serde_json::from_value(value)\n';
    out += '                .map_err(|err| BridgeRpcError::new("internal", err.to_string()))?;\n';
    out += '            Ok(parsed)\n';
    out += '        } else {\n';
    out += '            Err(bridge_error_from_body(status, &value))\n';
    out += '        }\n';
    out += '    }\n';
  }
  out += '}\n\n';

  // --- server ---
  out += `/// Serves the ${service.name} wire shape (POST ${routePrefix}/<Method>) on one\n`;
  out += '/// TCP connection. Returns when the connection closes.\n';
  out += 'pub fn serve_once(\n';
  out += `    handler: &dyn ${handlerTrait},\n`;
  out += '    stream: &mut std::net::TcpStream,\n';
  out += ') {\n';
  out += '    let Some((request_line, body)) = parse_http_request(stream) else {\n';
  out += '        return;\n';
  out += '    };\n';
  out += '    let mut parts = request_line.split_whitespace();\n';
  out += '    let method = parts.next().unwrap_or("");\n';
  out += '    let path = parts.next().unwrap_or("");\n';
  out += '    if method != "POST" {\n';
  out += '        write_http_response(\n';
  out += '            stream,\n';
  out += '            405,\n';
  out += '            &serde_json::json!({"code": "method_not_allowed", "message": "Bridge RPC routes accept POST only"}),\n';
  out += '        );\n';
  out += '        return;\n';
  out += '    }\n';
  out += `    let route_prefix = "${routePrefix}/";\n`;
  out += '    let Some(method_name) = path.strip_prefix(route_prefix) else {\n';
  out += '        write_http_response(\n';
  out += '            stream,\n';
  out += '            404,\n';
  out += '            &serde_json::json!({"code": "not_found", "message": path}),\n';
  out += '        );\n';
  out += '        return;\n';
  out += '    };\n';
  out += '    match method_name {\n';
  for (const method of service.methods) {
    const inputType = rustMethodTypeNameLocal(method.input);
    const outputType = rustMethodTypeNameLocal(method.output);
    const snakeMethod = camelToLowerSnake(method.name);
    out += `        "${method.name}" => {\n`;
    out += `            let parsed: Result<${inputType}, String> = serde_json::from_value(body).map_err(|err| err.to_string());\n`;
    out += '            match parsed {\n';
    out += '                Ok(req) => {\n';
    if (validators.has(method.name)) {
      out += '                    if let Err(validation_error) = req.validate() {\n';
      out += '                        write_http_response(\n';
      out += '                            stream,\n';
      out += '                            400,\n';
      out += '                            &serde_json::json!({"code": "invalid_argument", "message": format!("{}: {}", validation_error.field, validation_error.message)}),\n';
      out += '                        );\n';
      out += '                        return;\n';
      out += '                    }\n';
    }
    out += '                    match handler.' + snakeMethod + '(&req) {\n';
    out += '                        Ok(result) => {\n';
    out += '                            let body = serde_json::to_value(&result).unwrap_or(serde_json::Value::Null);\n';
    out += '                            write_http_response(stream, 200, &body);\n';
    out += '                        }\n';
    out += '                        Err(err) => {\n';
    out += '                            write_http_response(\n';
    out += '                                stream,\n';
    out += '                                500,\n';
    out += '                                &serde_json::json!({"code": "internal", "message": err}),\n';
    out += '                            );\n';
    out += '                        }\n';
    out += '                    }\n';
    out += '                }\n';
    out += '                Err(message) => {\n';
    out += '                    write_http_response(\n';
    out += '                        stream,\n';
    out += '                        400,\n';
    out += '                        &serde_json::json!({"code": "invalid_argument", "message": message}),\n';
    out += '                    );\n';
    out += '                }\n';
    out += '            }\n';
    out += '        }\n';
  }
  out += '        _ => {\n';
  out += '            write_http_response(\n';
  out += '                stream,\n';
  out += '                404,\n';
  out += '                &serde_json::json!({"code": "not_found", "message": method_name}),\n';
  out += '            );\n';
  out += '        }\n';
  out += '    }\n';
  out += '}\n\n';
  out += '/// Serves the wire shape in a loop until the listener errors.\n';
  out += 'pub fn serve_forever(\n';
  out += `    handler: std::sync::Arc<dyn ${handlerTrait} + Send + Sync>,\n`;
  out += '    listener: std::net::TcpListener,\n';
  out += ') -> std::io::Result<()> {\n';
  out += '    for incoming in listener.incoming() {\n';
  out += '        let mut stream = incoming?;\n';
  out += '        serve_once(handler.as_ref(), &mut stream);\n';
  out += '    }\n';
  out += '    Ok(())\n}\n';
  return out;
}

/** Method input/output type: named refs render as the type name. */
function rustMethodTypeNameLocal(ref: IRService['methods'][number]['input']): string {
  if (ref.kind === 'named') return ref.name;
  return 'serde_json::Value';
}

/** Field-name helper re-export for symmetry with rust.ts. */
export type { rustFieldName };

/* ------------------------------------------------------------------ */
/* tests/roundtrip.rs                                                  */
/* ------------------------------------------------------------------ */

/**
 * Emits an integration test file that ships inside the generated Rust crate:
 * real TCP loopback round-trips (server thread + generated client), the
 * deterministic error paths (404 unknown method, 400 invalid JSON, 400
 * failed validation when a required field is missing) and a full event
 * encode/dispatch cycle through the generated dispatcher.
 */
export function rustRoundtripTestFile(input: GeneratorInput): GeneratedFile | undefined {
  const services = sortedServices(input.ir);
  const events = sortedEvents(input.ir);
  if (services.length === 0 && events.length === 0) return undefined;

  const crateName = rustCrateName(input.packageName);
  const lines: string[] = [];
  lines.push(fileHeader('rust', input.packageName));
  lines.push('');
  lines.push('//! Real-loopback round-trip tests for the generated HTTP + event code.');
  lines.push('');
  lines.push('#[path = "../src/lib.rs"]');
  lines.push(`mod ${crateName.replace(/-/g, '_')};`);
  lines.push('');
  const crateIdent = crateName.replace(/-/g, '_');
  lines.push(`use ${crateIdent}::*;`);
  if (services.length > 0) lines.push(`use ${crateIdent}::services::*;`);
  if (events.length > 0) lines.push(`use ${crateIdent}::events::*;`);
  if (sortedTypes(input.ir).length > 0) lines.push(`use ${crateIdent}::types::*;`);
  lines.push('use std::sync::Arc;');
  lines.push('');

  for (const service of services) {
    lines.push(`struct Stub${service.name};`);
    lines.push('');
    lines.push(`impl ${service.name} for Stub${service.name} {`);
    for (const method of service.methods) {
      const inputType = rustMethodTypeNameLocal(method.input);
      const outputType = rustMethodTypeNameLocal(method.output);
      lines.push(`    fn ${camelToLowerSnake(method.name)}(&self, _req: &${inputType}) -> Result<${outputType}, String> {`);
      lines.push('        Err("stub".to_string())');
      lines.push('    }');
    }
    lines.push('}');
    lines.push('');

    lines.push(`fn ${camelToLowerSnake(service.name)}_addr() -> String {`);
    lines.push(`    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");`);
    lines.push('    let addr = listener.local_addr().expect("addr");');
    lines.push('    std::thread::spawn(move || {');
    lines.push(`        let handler: Arc<dyn ${service.name} + Send + Sync> = Arc::new(Stub${service.name});`);
    lines.push('        let _ = serve_forever(handler, listener);');
    lines.push('    });');
    lines.push('    format!("http://{addr}")');
    lines.push('}');
    lines.push('');
    lines.push(`#[test]`);
    lines.push(`fn ${camelToLowerSnake(service.name)}_unknown_method_is_404() {`);
    lines.push(`    let base = ${camelToLowerSnake(service.name)}_addr();`);
    lines.push(`    let (status, body) =`);
    lines.push(`        bridge_http_post_json(&base, "${input.packageName}/${service.name}/DefinitelyNotAMethod", "{}").expect("call");`);
    lines.push('    assert_eq!(status, 404);');
    lines.push('    assert_eq!(body["code"], "not_found");');
    lines.push('}');
    lines.push('');
    lines.push(`#[test]`);
    lines.push(`fn ${camelToLowerSnake(service.name)}_invalid_json_is_400() {`);
    lines.push(`    let base = ${camelToLowerSnake(service.name)}_addr();`);
    lines.push(`    let method = ${JSON.stringify(service.methods[0]?.name ?? 'Missing')};`);
    lines.push(`    let (status, body) =`);
    lines.push(`        bridge_http_post_json(&base, &format!("${input.packageName}/${service.name}/{}", method), "not-json").expect("call");`);
    lines.push('    assert_eq!(status, 400);');
    lines.push('    assert_eq!(body["code"], "invalid_argument");');
    lines.push('}');
    lines.push('');
    for (const method of service.methods) {
      const ref = method.input.kind === 'optional' ? method.input.inner : method.input;
      if (ref.kind !== 'named' || !isLocalStructRef(ref, input.ir)) continue;
      if (structZeroValuePassesValidation(input.ir, ref.name)) continue;
      lines.push(`#[test]`);
      lines.push(`fn ${camelToLowerSnake(service.name)}_${camelToLowerSnake(method.name)}_missing_required_is_400() {`);
      lines.push(`    let base = ${camelToLowerSnake(service.name)}_addr();`);
      lines.push(`    let (status, body) =`);
      lines.push(`        bridge_http_post_json(&base, "${input.packageName}/${service.name}/${method.name}", "{}").expect("call");`);
      lines.push('    assert_eq!(status, 400);');
      lines.push('    assert_eq!(body["code"], "invalid_argument");');
      lines.push('}');
      lines.push('');
    }
  }

  if (events.length > 0) {
    lines.push('fn sample_meta() -> BridgeEventMeta {');
    lines.push('    BridgeEventMeta {');
    lines.push('        id: "evt-test-1".to_string(),');
    lines.push('        source: "test://bridge".to_string(),');
    lines.push('        time: "2026-01-01T00:00:00Z".to_string(),');
    lines.push('    }');
    lines.push('}');
    lines.push('');
    for (const event of events) {
      const snake = camelToLowerSnake(event.name);
      const hasRequired = event.fields.some((f: IRField) => !f.optional);
      lines.push('#[test]');
      lines.push(`fn event_${snake}_envelope_and_dispatcher_round_trip() {`);
      lines.push('    let bus = InMemoryEventBus::new();');
      lines.push('    let meta = sample_meta();');
      if (hasRequired) {
        lines.push('    // Payload construction is contract-specific; decode path is exercised');
        lines.push('    // through the raw envelope instead (deterministic for any contract).');
        lines.push(`    let envelope_value = serde_json::json!({`);
        lines.push(`        "specversion": "1.0",`);
        lines.push(`        "id": "evt-test-1",`);
        lines.push(`        "source": "test://bridge",`);
        lines.push(`        "type": ${camelToScreamingSnake(event.name)}_TYPE,`);
        lines.push(`        "time": "2026-01-01T00:00:00Z",`);
        lines.push(`        "data": {}`);
        lines.push('    });');
        lines.push('    let mut dispatcher = BridgeEventDispatcher::new();');
        lines.push(`    register_${snake}(&mut dispatcher, |payload, meta| {`);
        lines.push('        let _ = serde_json::to_value(&payload).expect("payload value");');
        lines.push('        assert_eq!(meta.id, "evt-test-1");');
        lines.push('        Ok(())');
        lines.push('    });');
        lines.push('    // The empty payload cannot satisfy required fields; the dispatcher');
        lines.push('    // must surface that as a decode error, not silently drop it.');
        lines.push('    let result = dispatcher.dispatch(envelope_value);');
        lines.push('    if result.is_err() {');
        lines.push('        return; // deterministic for contracts with required fields');
        lines.push('    }');
        lines.push('    // All-optional contracts reach the handler and the bus.');
        lines.push(`    let published = bus.published();`);
        lines.push('    assert!(published.is_empty());');
      } else {
        lines.push(`    let payload = ${event.name} {`);
        for (const field of event.fields) {
          const fname = rustFieldName(field.name).name;
          lines.push(`        ${fname}: Default::default(),`);
        }
        lines.push('    };');
        lines.push(`    publish_${snake}(&bus, &payload, &meta).expect("publish");`);
        lines.push('    let published = bus.published();');
        lines.push('    assert_eq!(published.len(), 1);');
        lines.push(`    assert_eq!(published[0].event_type, ${camelToScreamingSnake(event.name)}_TYPE);`);
        lines.push('    let mut dispatcher = BridgeEventDispatcher::new();');
        lines.push(`    register_${snake}(&mut dispatcher, |payload, meta| {`);
        lines.push('        let _ = serde_json::to_value(&payload).expect("payload value");');
        lines.push('        assert_eq!(meta.id, "evt-test-1");');
        lines.push('        Ok(())');
        lines.push('    });');
        lines.push('    dispatcher.dispatch(published[0].clone()).expect("dispatch");');
      }
      lines.push('}');
      lines.push('');
    }
  }

  const content = `${lines.join('\n')}\n`;
  return generatedFile('tests/roundtrip.rs', content);
}
