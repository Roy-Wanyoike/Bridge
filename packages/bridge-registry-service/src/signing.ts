/**
 * Artifact signing: ed25519 signatures over publish payloads.
 *
 * Publishers sign the canonical JSON of the publish body with an ed25519
 * private key; the service verifies against the configured public half
 * before persisting. Because the message is the *canonical* JSON (keys
 * sorted, via `@bridge/core`'s `canonicalJson`), any byte-level
 * re-serialization of the same object still verifies, but any content
 * change — even a single value — invalidates the signature (tamper
 * detection).
 *
 * Wire format (request headers):
 * - `x-bridge-key-id`: key id configured in `SigningConfig.keys`
 * - `x-bridge-signature`: base64 (or base64url) ed25519 signature
 *
 * Additionally, a publish body MAY carry `contentHash` (SHA-256 hex of the
 * canonical IR). When present, the service compares it to the freshly
 * computed `hashPackage(ir)` and rejects mismatches with 400 — an explicit
 * tamper tripwire that is independent of the signature.
 *
 * Versioned signature envelope (issue #120): the LEGACY format signs only
 * the request body, so the signature is not bound to the route coordinates
 * the body is published into. The server additionally accepts a v2 envelope
 * placed in the reserved body key {@link SIGNED_ENVELOPE_KEY}:
 *
 *     bridgeSignature: {
 *       version: 2,                       // literal
 *       org, project, contract,           // route coordinates as targeted
 *       contractVersion: 'v1' | null,     // version embedded in the route, if any
 *       bodyHash: '<64-hex sha256 of canonicalJson(body minus this key)>',
 *     }
 *
 * signed (ed25519, same headers as legacy) over the CANONICAL JSON of the
 * envelope itself. The service strips the key, re-computes `bodyHash`,
 * checks the coordinates against the actual route, and verifies the
 * signature over the envelope. Clients that sign body-only (the CLI today)
 * keep working unchanged; both formats are accepted until the CLI migrates.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@bridge/core';
import { ServiceError } from './errors';
import type { SigningConfig } from './types';

const SIGNATURE_HEADER = 'x-bridge-signature';
const KEY_ID_HEADER = 'x-bridge-key-id';
const MAX_SIGNATURE_LENGTH = 512;
const MAX_KEY_ID_LENGTH = 256;
/** Bound for envelope coordinate strings (org/project/contract). */
const MAX_COORDINATE_LENGTH = 256;
/**
 * Max canonical-JSON nesting depth accepted while verifying a publish body
 * (issue #48): `canonicalJson` recurses over the WHOLE body (including keys
 * the publish flow otherwise ignores), so an unbounded ~10k-deep payload
 * used to surface as `RangeError` → 500. A depth-capped document is a
 * client error instead (400).
 */
export const MAX_CANONICAL_DEPTH = 512;

/**
 * Reserved publish-body key carrying the v2 signed envelope (issue #120).
 * Documented in the module header; clients must not use it for anything else.
 */
export const SIGNED_ENVELOPE_KEY = 'bridgeSignature';

/** Route coordinates a publish is being made into (for envelope binding). */
export interface PublishCoordinates {
  org: string;
  project: string;
  /** Contract name from the route (base or versioned, as written). */
  contract: string;
  /** Version embedded in the route contract name, or `null` when bare. */
  version: string | null;
}

/** The v2 signed envelope (see {@link SIGNED_ENVELOPE_KEY}). */
export interface SignatureEnvelopeV2 {
  version: 2;
  org: string;
  project: string;
  contract: string;
  contractVersion: string | null;
  /** SHA-256 hex of `canonicalJson(body)` with the envelope key removed. */
  bodyHash: string;
}

/** SHA-256 hex of the canonical JSON of `body` (the v2 `bodyHash` recipe). */
export function canonicalBodyHash(body: unknown): string {
  return createHash('sha256').update(Buffer.from(canonicalJson(body, MAX_CANONICAL_DEPTH), 'utf8')).digest('hex');
}

/** Structural validation of a claimed v2 envelope. */
function parseEnvelopeV2(candidate: unknown): SignatureEnvelopeV2 {
  if (!isRecord(candidate)) {
    throw new ServiceError(401, 'invalid-signature', 'bridgeSignature must be a signature envelope object');
  }
  if (candidate['version'] !== 2) {
    throw new ServiceError(401, 'invalid-signature', 'bridgeSignature.version must be 2');
  }
  for (const field of ['org', 'project', 'contract'] as const) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_COORDINATE_LENGTH) {
      throw new ServiceError(401, 'invalid-signature', `bridgeSignature.${field} must be a 1..${MAX_COORDINATE_LENGTH} char string`);
    }
  }
  const contractVersion = candidate['contractVersion'];
  if (contractVersion !== null && (typeof contractVersion !== 'string' || contractVersion.length === 0 || contractVersion.length > MAX_COORDINATE_LENGTH)) {
    throw new ServiceError(401, 'invalid-signature', 'bridgeSignature.contractVersion must be a non-empty string or null');
  }
  const bodyHash = candidate['bodyHash'];
  if (typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyHash)) {
    throw new ServiceError(401, 'invalid-signature', 'bridgeSignature.bodyHash must be a 64-char lowercase hex SHA-256');
  }
  return {
    version: 2,
    org: candidate['org'] as string,
    project: candidate['project'] as string,
    contract: candidate['contract'] as string,
    contractVersion: contractVersion as string | null,
    bodyHash,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { SIGNATURE_HEADER, KEY_ID_HEADER };

interface LoadedKeys {
  keys: Map<string, KeyObject>;
  mode: 'required' | 'optional';
}

/**
 * Effective signing mode of a config: `'required'` only when at least one
 * key is configured and `mode` is not explicitly `'optional'`. Used by the
 * server for the loud boot warning when signing is silently optional
 * (issue #48) — keep in lockstep with {@link loadKeys}.
 */
export function effectiveSigningMode(config: SigningConfig | undefined): 'required' | 'optional' {
  const keys = config?.keys;
  if (keys !== undefined && typeof keys === 'object' && Object.keys(keys).length > 0) {
    return config!.mode ?? 'required';
  }
  return 'optional';
}

function loadKeys(config: SigningConfig | undefined): LoadedKeys {
  const keys = new Map<string, KeyObject>();
  let mode: 'required' | 'optional' = 'optional';
  if (config !== undefined && config.keys !== undefined && typeof config.keys === 'object') {
    for (const [kid, pem] of Object.entries(config.keys)) {
      if (typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KEY_ID_LENGTH) {
        throw new TypeError(`signing.keys: key ids must be non-empty strings (max ${MAX_KEY_ID_LENGTH} chars)`);
      }
      if (typeof pem !== 'string' && !Buffer.isBuffer(pem)) {
        throw new TypeError(`signing.keys[${kid}]: expected a PEM string or Buffer`);
      }
      let key: KeyObject;
      try {
        key = createPublicKeySafe(pem);
      } catch (err) {
        throw new TypeError(`signing.keys[${kid}]: not a readable public key: ${(err as Error).message}`);
      }
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new TypeError(`signing.keys[${kid}]: only ed25519 keys are supported`);
      }
      keys.set(kid, key);
    }
    if (keys.size > 0) mode = config.mode ?? 'required';
  }
  return { keys, mode };
}

function createPublicKeySafe(pem: string | Buffer): KeyObject {
  return createPublicKey(pem as string);
}

/** Parsed signature material from request headers. */
export interface ArtifactSignature {
  keyId: string;
  signature: Buffer;
}

/** Extract and structurally validate signature headers (no crypto yet). */
export function parseSignatureHeaders(headers: Record<string, string | string[] | undefined>): ArtifactSignature | null {
  const rawSig = headerValue(headers, SIGNATURE_HEADER);
  const rawKid = headerValue(headers, KEY_ID_HEADER);
  if (rawSig === undefined && rawKid === undefined) return null;
  if (rawSig === undefined || rawKid === undefined) {
    throw new ServiceError(
      401,
      'invalid-signature',
      `publish requires both ${SIGNATURE_HEADER} and ${KEY_ID_HEADER} headers`,
    );
  }
  if (rawSig.length > MAX_SIGNATURE_LENGTH || !/^[A-Za-z0-9+/=_-]+$/.test(rawSig)) {
    throw new ServiceError(401, 'invalid-signature', 'signature header is malformed');
  }
  if (rawKid.length > MAX_KEY_ID_LENGTH) {
    throw new ServiceError(401, 'invalid-signature', 'key id header is malformed');
  }
  const signature = Buffer.from(rawSig, 'base64');
  if (signature.length !== 64) {
    throw new ServiceError(401, 'invalid-signature', 'ed25519 signatures are 64 bytes');
  }
  return { keyId: rawKid, signature };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && direct.length > 0 && typeof direct[0] === 'string') return direct[0];
  // Node lower-cases incoming header names; tolerate exact-case too.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** Outcome of publish-signature verification. */
export interface PublishSignatureResult {
  mode: 'required' | 'optional';
  signed: boolean;
  /** Present when the body carried a verified v2 envelope. */
  envelope?: SignatureEnvelopeV2;
}

/**
 * Verify the artifact signature over the canonical JSON of `body`.
 *
 * Two formats are accepted (issue #120):
 * - LEGACY: signature over `canonicalJson(body)` — the CLI's current format.
 * - V2: the body carries {@link SIGNED_ENVELOPE_KEY} with
 *   `{version: 2, org, project, contract, contractVersion, bodyHash}`; the
 *   signature covers `canonicalJson(envelope)`, and `bodyHash` must match
 *   the re-computed canonical hash of the body with the envelope key
 *   removed. When `coordinates` is supplied, the envelope's coordinates
 *   must match them exactly (replay of a captured signed body into another
 *   org/project/contract/version slot is rejected with 400).
 *
 * On the V2 path the envelope key is REMOVED from `body` (mutated in place)
 * before verification so downstream publish handling never sees it.
 */
export function verifyPublishSignature(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  config: SigningConfig | undefined,
  coordinates?: PublishCoordinates,
): PublishSignatureResult {
  const { keys, mode } = loadKeys(config);
  const parsed = parseSignatureHeaders(headers);

  if (parsed === null) {
    if (mode === 'required') {
      throw new ServiceError(
        401,
        'signature-required',
        `publishes must be signed: set the ${SIGNATURE_HEADER} and ${KEY_ID_HEADER} headers ` +
          '(ed25519 signature over the canonical JSON of the request body)',
      );
    }
    return { mode, signed: false };
  }

  const key = keys.get(parsed.keyId);
  if (key === undefined) {
    throw new ServiceError(401, 'invalid-signature', `unknown signing key id '${parsed.keyId}'`);
  }

  // V2 envelope path: detach the envelope, bind the body by hash, bind the
  // route by coordinate comparison, verify the signature over the envelope.
  let envelope: SignatureEnvelopeV2 | undefined;
  let message: Buffer;
  try {
    if (isRecord(body) && body[SIGNED_ENVELOPE_KEY] !== undefined) {
      envelope = parseEnvelopeV2(body[SIGNED_ENVELOPE_KEY]);
      delete body[SIGNED_ENVELOPE_KEY];
      if (canonicalBodyHash(body) !== envelope.bodyHash) {
        throw new ServiceError(
          401,
          'invalid-signature',
          'artifact signature verification failed: the signed body hash does not match the payload',
        );
      }
      if (coordinates !== undefined) {
        const routeVersion = coordinates.version ?? null;
        if (
          envelope.org !== coordinates.org ||
          envelope.project !== coordinates.project ||
          envelope.contract !== coordinates.contract ||
          (envelope.contractVersion ?? null) !== routeVersion
        ) {
          throw new ServiceError(
            400,
            'invalid_argument',
            `signed publish coordinates (org=${envelope.org}, project=${envelope.project}, ` +
              `contract=${envelope.contract}, version=${envelope.contractVersion ?? 'none'}) do not match ` +
              `the request route (org=${coordinates.org}, project=${coordinates.project}, ` +
              `contract=${coordinates.contract}, version=${routeVersion ?? 'none'})`,
          );
        }
      }
      message = Buffer.from(canonicalJson(envelope, MAX_CANONICAL_DEPTH), 'utf8');
    } else {
      // Legacy format: signature over the canonical JSON of the whole body.
      message = Buffer.from(canonicalJson(body, MAX_CANONICAL_DEPTH), 'utf8');
    }
  } catch (err) {
    if (err instanceof RangeError) {
      // issue #48: map unbounded-recursion DoS bodies to a client error.
      throw new ServiceError(
        400,
        'invalid_argument',
        `request body nesting exceeds the maximum supported canonical-JSON depth (${MAX_CANONICAL_DEPTH})`,
      );
    }
    throw err;
  }
  if (!cryptoVerify(null, message, key, parsed.signature)) {
    throw new ServiceError(
      401,
      'invalid-signature',
      'artifact signature verification failed: the payload does not match the signature',
    );
  }
  return envelope !== undefined ? { mode, signed: true, envelope } : { mode, signed: true };
}

/** Compare an optional declared `contentHash` with the actual IR hash. */
export function assertContentHash(bodyIsh: Record<string, unknown>, actualHash: string): void {
  const declared = bodyIsh['contentHash'];
  if (declared === undefined) return;
  if (typeof declared !== 'string' || !/^[a-f0-9]{64}$/.test(declared)) {
    throw new ServiceError(400, 'invalid_argument', 'contentHash must be a 64-char lowercase hex SHA-256');
  }
  if (declared !== actualHash) {
    throw new ServiceError(
      400,
      'hash-mismatch',
      `contentHash mismatch: declared ${declared}, actual ${actualHash}. ` +
        'The payload was tampered with or the publisher hashed different content.',
    );
  }
}
