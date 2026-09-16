/**
 * Hand-written OpenAPI 3.1 document for the registry service API.
 *
 * Keeping the document as a typed object (no codegen, no dependencies)
 * preserves the zero-dependency story of the service and keeps the
 * document deterministic. Every route and the shared `Error` envelope
 * schema are described here; the document is served at
 * `GET /v1/openapi.json`.
 */

import type { RegistryServiceOptions } from './types';

/**
 * Builds the OpenAPI document. `info.version` tracks the service package
 * version. The signature is async-free and deterministic.
 */
export function openApiDocument(_options?: RegistryServiceOptions): Record<string, unknown> {
  const errorSchema = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            description: 'Machine-readable code (see the codes enum).',
            enum: [
              'invalid_argument',
              'invalid_contract',
              'hash-mismatch',
              'unauthenticated',
              'signature-required',
              'invalid-signature',
              'forbidden',
              'missing-org-claim',
              'not-found',
              'method-not-allowed',
              'payload-too-large',
              'rate-limited',
              'auth-unconfigured',
              'storage-unavailable',
              'internal',
              // RegistryError codes passed through from the storage layer:
              'not-found',
              'immutable',
              'hash-conflict',
              'invalid-name',
              'invalid-version',
              'corrupt',
              'io',
            ],
          },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  };

  const contractMetaSchema = {
    type: 'object',
    required: ['org', 'project', 'packageName', 'base', 'version', 'hash', 'shortHash', 'imports', 'publishedAt'],
    properties: {
      org: { type: 'string' },
      project: { type: 'string' },
      packageName: { type: 'string', example: 'payments.v1' },
      base: { type: 'string', example: 'payments' },
      version: { type: 'string', example: 'v1' },
      hash: { type: 'string', description: 'SHA-256 (hex) of the canonical IR JSON' },
      shortHash: { type: 'string' },
      imports: { type: 'array', items: { type: 'string' } },
      publishedAt: { type: 'string', format: 'date-time' },
      publishedBy: { type: 'string' },
      description: { type: 'string' },
      repository: { type: 'string' },
    },
  };

  const ok = 'Read succeeded.';
  const security = [{ bearerAuth: [] }];

  return {
    openapi: '3.1.0',
    info: {
      title: 'Bridge Registry Service',
      version: '0.2.1',
      description:
        'Multi-tenant contract registry for Bridge: publish immutable, content-addressed ' +
        'contract versions; query versions, consumers and dependency graphs; diff any two ' +
        'versions of a contract. Cross-tenant resources always respond 404.',
    },
    servers: [{ url: '/', description: 'current host' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT or static token',
          description:
            'OIDC JWT (RS256/ES256) verified against the configured JWKS, or a configured static bearer token. ' +
            'Tokens are bound to one org.',
        },
      },
      schemas: { Error: errorSchema, ContractMeta: contractMetaSchema },
    },
    paths: {
      '/healthz': {
        get: {
          summary: 'Liveness probe (unauthenticated).',
          responses: {
            200: { description: 'Service is up.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } } } } } },
          },
        },
      },
      '/v1/openapi.json': {
        get: { summary: 'This document.', responses: { 200: { description: ok } } },
      },
      '/v1/search': {
        get: {
          summary: 'Substring search over contract names/bases/descriptions in the caller org.',
          security,
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive substring.' },
          ],
          responses: {
            200: { description: ok },
            401: { description: 'Unauthenticated.', content: { 'application/json': { schema: errorSchema } } },
            429: { description: 'Rate limited (Retry-After header).', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/v1/audit': {
        get: {
          summary: 'Query the audit log (admin scope only), newest first.',
          security,
          parameters: [
            { name: 'org', in: 'query', schema: { type: 'string' } },
            { name: 'project', in: 'query', schema: { type: 'string' } },
            { name: 'actor', in: 'query', schema: { type: 'string' } },
            { name: 'action', in: 'query', schema: { type: 'string' } },
            { name: 'contract', in: 'query', schema: { type: 'string' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 10000 } },
          ],
          responses: {
            200: { description: ok },
            403: { description: 'Insufficient scope (registry:admin required).', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts': {
        get: {
          summary: 'List latest contract metadata for a project.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: ok },
            404: { description: 'Unknown route or cross-tenant access.', content: { 'application/json': { schema: errorSchema } } },
          },
        },
        post: {
          summary:
            'Publish with the package name taken from the body ( packageName field). ' +
            'Signature headers apply when signing is configured.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ir'],
                  properties: {
                    packageName: { type: 'string', description: 'Full dotted package name, e.g. payments.v1.' },
                    ir: { type: 'object', additionalProperties: true, description: 'Canonical Bridge IR package.' },
                    meta: { type: 'object', properties: { description: { type: 'string' }, repository: { type: 'string' } } },
                    version: { type: 'string', description: 'Used when the package name has no version segment.' },
                    publishTime: { type: 'string', format: 'date-time' },
                    contentHash: { type: 'string', description: 'Optional SHA-256 hex tripwire over the canonical IR.' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Created (new version).' },
            200: { description: 'Replayed (identical content republished).' },
            400: { description: 'Validation failure.', content: { 'application/json': { schema: errorSchema } } },
            401: { description: 'Signature problem.', content: { 'application/json': { schema: errorSchema } } },
            409: { description: 'Immutable version republished with different content.', content: { 'application/json': { schema: errorSchema } } },
            413: { description: 'Body too large.', content: { 'application/json': { schema: errorSchema } } },
            429: { description: 'Publish rate limited.', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts/{contract}': {
        get: {
          summary: 'Fetch the latest version (IR + meta) of a contract.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' }, description: 'Base name or `base.vN`.' },
          ],
          responses: { 200: { description: ok }, 404: { description: 'Unknown or cross-tenant.', content: { 'application/json': { schema: errorSchema } } } },
        },
        put: {
          summary: 'Publish a contract version (PUT semantics; POST is accepted too).',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          responses: {
            201: { description: 'Created.' },
            200: { description: 'Replayed.' },
            400: { description: 'Validation failure.', content: { 'application/json': { schema: errorSchema } } },
            401: { description: 'Signature problem.', content: { 'application/json': { schema: errorSchema } } },
            409: { description: 'Immutability conflict.', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts/{contract}/versions': {
        get: {
          summary: 'List all published versions of a contract.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: ok }, 404: { description: 'Unknown or cross-tenant.', content: { 'application/json': { schema: errorSchema } } } },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts/{contract}/versions/{version}': {
        get: {
          summary: 'Fetch one version (IR + meta); integrity is re-verified on every pull.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'version', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: ok }, 404: { description: 'Unknown or cross-tenant.', content: { 'application/json': { schema: errorSchema } } } },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts/{contract}/versions/{version}/consumers': {
        get: {
          summary: 'Contracts in the same project that depend on this contract.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'version', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: ok }, 404: { description: 'Unknown or cross-tenant.', content: { 'application/json': { schema: errorSchema } } } },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts/{contract}/diff': {
        get: {
          summary: 'Classified compatibility report between two versions.',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'from', in: 'query', required: true, schema: { type: 'string' }, description: 'Older version, e.g. v1.' },
            { name: 'to', in: 'query', required: true, schema: { type: 'string' }, description: 'Newer version, e.g. v2.' },
          ],
          responses: { 200: { description: ok }, 400: { description: 'Missing version params.', content: { 'application/json': { schema: errorSchema } } }, 404: { description: 'Unknown or cross-tenant.', content: { 'application/json': { schema: errorSchema } } } },
        },
      },
      '/v1/orgs/{org}/projects/{project}/contracts/{contract}/graph': {
        get: {
          summary: 'Dependency closure of the latest version (nodes + edges).',
          security,
          parameters: [
            { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'contract', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: ok }, 404: { description: 'Unknown or cross-tenant.', content: { 'application/json': { schema: errorSchema } } } },
        },
      },
    },
  };
}
