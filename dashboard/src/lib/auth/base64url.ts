/**
 * Runtime-agnostic base64 / base64url helpers (issue #163).
 *
 * The auth layer runs in three contexts — the Next.js proxy, route handlers
 * and unit tests under jsdom — and must not assume `Buffer` (edge runtime)
 * or `btoa` (binary-string pitfalls with non-ASCII secrets). These helpers
 * are pure TypeScript over `Uint8Array`, so every runtime behaves
 * identically, and they are deterministic enough to assert in tests.
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64url (RFC 4648 §5) encode — no padding, safe for URLs and cookies. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63];
  }
  return out;
}

/** Padded standard base64 (RFC 4648 §4) — only used for HTTP Basic auth. */
export function encodeBase64Standard(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64STD[(n >>> 18) & 63] + B64STD[(n >>> 12) & 63] + B64STD[(n >>> 6) & 63] + B64STD[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64STD[(n >>> 18) & 63] + B64STD[(n >>> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64STD[(n >>> 18) & 63] + B64STD[(n >>> 12) & 63] + B64STD[(n >>> 6) & 63] + '=';
  }
  return out;
}

const B64_ALPHABET: Record<string, number> = {};
for (let i = 0; i < 64; i++) {
  B64_ALPHABET[B64STD[i]] = i;
  // base64url chars decode identically — one table covers both alphabets.
  B64_ALPHABET[B64URL[i]] = i;
}

/** Decode base64 or base64url into bytes. Returns null on any invalid input. */
export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, '');
  if (clean.length === 0) return new Uint8Array(0);
  const outLen = Math.floor((clean.length * 6) / 8);
  if (outLen === 0) return null;
  const out = new Uint8Array(outLen);
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET[ch];
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >>> bits) & 0xff;
    }
  }
  // Trailing bits that cannot form a byte must be zero (canonical encodings only).
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  // Copy constructor: TextEncoder returns Uint8Array<ArrayBufferLike>; the
  // DOM crypto APIs (importKey/sign/digest) require BufferSource backed by
  // a plain ArrayBuffer, which `new Uint8Array(view)` guarantees.
  return new Uint8Array(new TextEncoder().encode(text));
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
