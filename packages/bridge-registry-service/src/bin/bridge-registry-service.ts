/**
 * CLI entry: `bridge-registry-service`.
 *
 * No top-level side effects — `main()` runs only when this file is
 * executed directly, so importing the compiled module is always
 * side-effect free.
 *
 * Storage: in-memory by default, PostgreSQL via `--driver postgres
 * --pg-dsn ...` (migrations in `migrations/` are applied on boot).
 * Auth: static bearer tokens via `--token secret=tenant:role`; OIDC via
 * `--oidc-issuer/--oidc-audience` (+ optional `--oidc-jwks-url`).
 * Signing: `--signing-key <kid>=<pem-file>` (repeatable; required mode).
 */

import { readFileSync } from 'node:fs';
import { start } from '../server';
import { FileAuditSink } from '../audit';
import { assertTokenEntropy } from '../auth';
import { InMemoryDriver } from '../storage/memory';
import { PostgresDriver, parseDsn } from '../storage/postgres/driver';
import type { PgConnectOptions } from '../storage/postgres/driver';
import type { RegistryRole, RegistryServiceOptions, RegistryTokenInfo, StorageDriver } from '../types';

const USAGE = `bridge-registry-service — multi-tenant Bridge contract registry

Usage:
  bridge-registry-service [options]

Options:
  --port <n>                     TCP port to bind (default: 4350; 0 = auto-assign)
  --host <addr>                  Interface to bind (default: 127.0.0.1 —
                                 loopback only). Binding a non-loopback
                                 address (0.0.0.0, a LAN IP, ::) requires
                                 this explicit flag and prints a loud
                                 SECURITY WARNING to stderr before the
                                 socket opens.
  --driver <memory|postgres>     Storage driver (default: memory)
  --pg-dsn <dsn>                 PostgreSQL DSN (postgres/postgresql://user:pass@host/db)
  --token <secret>=<org>:<role>  Static bearer token; repeatable.
                                 role: read | write | admin. Tokens shorter
                                 than 32 characters (~128-bit entropy floor)
                                 warn on stderr; under the production
                                 profile they REFUSE to start.
  --oidc-issuer <url>            OIDC issuer (iss claim)
  --oidc-audience <aud>          OIDC audience (aud claim)
  --oidc-jwks-url <url>          JWKS URL (default: <issuer>/.well-known/jwks.json)
  --signing-key <kid>=<pemfile>  ed25519 public key (PEM/SPKI) for publish
                                 signature verification; repeatable. When any
                                 key is configured, signed publishes are
                                 REQUIRED unless --signing-optional is passed.
  --signing-optional             Allow unsigned publishes when keys are set
  --production-profile           Hardened defaults for internet-facing
                                 deployments: rate limiting ON, publish
                                 signing REQUIRED (needs at least one
                                 --signing-key; incompatible with
                                 --signing-optional), strict TLS for
                                 postgres (sslmode=require unless the DSN
                                 pins verify-full; sslmode=disable is
                                 refused).
  --audit <file.jsonl>           Mirror audit entries to an append-only JSONL
                                 file (entries always also go to the driver)
  --audit-retention-days <days>  Postgres only: delete bridge_audit rows older
                                 than <days> (boot sweep, then every 6h).
                                 Default: 30 — retention is always on so the
                                 audit table cannot grow unbounded. Env:
                                 BRIDGE_REGISTRY_AUDIT_RETENTION_DAYS
  -h, --help                     Show this help

Defaults (issue #48 hardening):
  - The service binds 127.0.0.1 (loopback) unless --host is given explicitly;
    any non-loopback bind prints a loud SECURITY WARNING to stderr first.
  - Static tokens shorter than 32 characters (~128-bit entropy floor) warn
    on stderr; --production-profile refuses to start with such tokens.
  - Postgres audit retention is ON by default at 30 days (issue #120); the
    flag/env above widens or narrows the window.
  - Rate limiting is ON with conservative buckets (auth: 120 capacity @
    30/s per IP; publish: 30 @ 5/s per principal). A boot log line says so.
  - A DSN without sslmode defaults to sslmode=prefer (TLS when the server
    supports it); cleartext password auth is refused on plaintext
    connections.
  - Missing signing configuration boots with a loud warning: unsigned
    publishes are accepted until keys are configured.

Environment (equivalents):
  BRIDGE_REGISTRY_PORT, BRIDGE_REGISTRY_DRIVER, PG_DSN,
  BRIDGE_REGISTRY_TOKEN (repeatable via ';': secret=org:role;secret2=org:role),
  BRIDGE_REGISTRY_PRODUCTION=1 (same as --production-profile)

Examples:
  bridge-registry-service --token dev-acme=acme:write --token ro=acme:read
  bridge-registry-service --driver postgres --pg-dsn postgres://bridge@localhost/bridge
  bridge-registry-service --production-profile --signing-key k1=./publisher.pub --driver postgres \\
    --pg-dsn postgres://bridge@db/bridge?sslmode=verify-full

Health:   curl http://127.0.0.1:4350/healthz
API doc:  curl http://127.0.0.1:4350/v1/openapi.json
Publish:  curl -X PUT -H 'Authorization: Bearer dev-acme' \\
            --data-binary @payments.ir.json \\
            http://127.0.0.1:4350/v1/orgs/acme/projects/payments/contracts/payments.v1
`;

/** Internal marker for command-line misuse (distinct from runtime errors). */
class UsageError extends Error {}

/**
 * Default bind host (issue #120 item 6): loopback only. The service is a
 * bearer-token-authenticated API with no built-in TLS; exposing it beyond
 * this machine must be an explicit `--host` decision.
 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * True for loopback bind targets: `localhost`, the whole `127.0.0.0/8` range
 * and `::1`. Anything else (0.0.0.0, `::`, LAN IPs, empty string) is a
 * network-exposed bind.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/**
 * Loud pre-bind warning for non-loopback binds (issue #120 item 6). Called
 * right before `server.listen` so the operator sees the exposure decision in
 * their terminal, not buried in a log file. Returns whether it warned.
 */
export function warnNonLoopbackBind(host: string | undefined): boolean {
  if (host === undefined || isLoopbackHost(host)) return false;
  process.stderr.write(
    `[bridge-registry-service] SECURITY WARNING: binding to '${host}' exposes the registry ` +
      'beyond this machine. The service authenticates with bearer tokens and has no built-in ' +
      'TLS — terminate TLS in front of it and prefer --production-profile. ' +
      '(Pass --host 127.0.0.1 to bind loopback only.)\n',
  );
  return true;
}

export interface Config {
  port: number;
  /** Bind host. Defaults to {@link DEFAULT_BIND_HOST} (127.0.0.1, loopback). */
  host?: string;
  driver: 'memory' | 'postgres';
  pgDsn?: string;
  tokens: Record<string, RegistryTokenInfo>;
  oidc?: { issuer: string; audience: string; jwksUrl?: string };
  signingKeys: Record<string, string>;
  signingOptional: boolean;
  productionProfile: boolean;
  auditFile?: string;
  /**
   * Audit retention window in days (postgres only). `undefined` applies the
   * postgres driver default (30 — issue #120 item 8); retention is always on.
   */
  auditRetentionDays?: number;
}

function envTokens(): Record<string, RegistryTokenInfo> {
  const raw = process.env['BRIDGE_REGISTRY_TOKEN'];
  const out: Record<string, RegistryTokenInfo> = {};
  if (raw === undefined) return out;
  for (const spec of raw.split(';')) {
    const eq = spec.indexOf('=');
    if (eq <= 0) continue;
    const secret = spec.slice(0, eq);
    const rest = spec.slice(eq + 1);
    const colon = rest.lastIndexOf(':');
    if (colon <= 0) continue;
    out[secret] = { tenant: rest.slice(0, colon), role: rest.slice(colon + 1) as RegistryRole };
  }
  return out;
}

/** Parse argv/env into a {@link Config} (exported for tests). */
export function parseArgs(argv: string[]): Config {
  const config: Config = {
    port: Number(process.env['BRIDGE_REGISTRY_PORT'] ?? 4350),
    // Loopback default (issue #120 item 6): an explicit --host is required to
    // bind anything else, and even then the bind warns loudly first.
    host: DEFAULT_BIND_HOST,
    driver: (process.env['BRIDGE_REGISTRY_DRIVER'] as Config['driver']) ?? 'memory',
    pgDsn: process.env['PG_DSN'],
    tokens: envTokens(),
    signingKeys: {},
    signingOptional: false,
    productionProfile:
      process.env['BRIDGE_REGISTRY_PRODUCTION'] === '1' ||
      process.env['BRIDGE_REGISTRY_PRODUCTION'] === 'true',
  };
  const envRetention = process.env['BRIDGE_REGISTRY_AUDIT_RETENTION_DAYS'];
  if (envRetention !== undefined && envRetention.length > 0) {
    const days = Number(envRetention);
    if (!Number.isInteger(days) || days < 1) {
      throw new UsageError(`BRIDGE_REGISTRY_AUDIT_RETENTION_DAYS must be an integer >= 1, got '${envRetention}'`);
    }
    config.auditRetentionDays = days;
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) config.port = 4350;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`option ${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '-h':
      case '--help':
        throw new UsageError('__HELP__');
      case '--port': {
        const raw = value();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new UsageError(`--port must be an integer in [0, 65535], got '${raw}'`);
        }
        config.port = port;
        break;
      }
      case '--host':
        config.host = value();
        break;
      case '--driver': {
        const d = value();
        if (d !== 'memory' && d !== 'postgres') {
          throw new UsageError(`--driver must be 'memory' or 'postgres', got '${d}'`);
        }
        config.driver = d;
        break;
      }
      case '--pg-dsn':
        config.pgDsn = value();
        break;
      case '--token': {
        const spec = value();
        const eq = spec.indexOf('=');
        if (eq <= 0) {
          throw new UsageError(`--token expects <secret>=<org>:<role>, got '${spec}'`);
        }
        const secret = spec.slice(0, eq);
        const rest = spec.slice(eq + 1);
        const colon = rest.lastIndexOf(':');
        const org = colon > 0 ? rest.slice(0, colon) : rest;
        const role = colon > 0 ? rest.slice(colon + 1) : '';
        if (secret.length === 0 || org.length === 0 || !['read', 'write', 'admin'].includes(role)) {
          throw new UsageError(`--token expects <secret>=<org>:<role> with role read|write|admin, got '${spec}'`);
        }
        config.tokens[secret] = { tenant: org, role: role as RegistryRole };
        break;
      }
      case '--oidc-issuer':
        config.oidc = config.oidc ?? { issuer: value(), audience: '' };
        config.oidc.issuer = config.oidc.issuer || '';
        break;
      case '--oidc-audience':
        config.oidc = config.oidc ?? { issuer: '', audience: value() };
        config.oidc.audience = config.oidc.audience || '';
        break;
      case '--oidc-jwks-url':
        config.oidc = config.oidc ?? { issuer: '', audience: '' };
        config.oidc.jwksUrl = value();
        break;
      case '--signing-key': {
        const spec = value();
        const eq = spec.indexOf('=');
        if (eq <= 0) throw new UsageError(`--signing-key expects <kid>=<pemfile>, got '${spec}'`);
        const kid = spec.slice(0, eq);
        const pem = readFileSync(spec.slice(eq + 1), 'utf8');
        config.signingKeys[kid] = pem;
        break;
      }
      case '--signing-optional':
        config.signingOptional = true;
        break;
      case '--production-profile':
        config.productionProfile = true;
        break;
      case '--audit':
        config.auditFile = value();
        break;
      case '--audit-retention-days': {
        const raw = value();
        const days = Number(raw);
        if (!Number.isInteger(days) || days < 1) {
          throw new UsageError(`--audit-retention-days must be an integer >= 1, got '${raw}'`);
        }
        config.auditRetentionDays = days;
        break;
      }
      default:
        throw new UsageError(`unknown option '${arg}' (see --help)`);
    }
  }

  if (config.oidc !== undefined && (config.oidc.issuer.length === 0 || config.oidc.audience.length === 0)) {
    throw new UsageError('--oidc-issuer and --oidc-audience are both required');
  }
  if (config.driver === 'postgres' && config.pgDsn === undefined) {
    throw new UsageError('--driver postgres requires --pg-dsn (or PG_DSN)');
  }
  return config;
}

/**
 * Strict-TLS rule for the production profile (issue #48): cleartext is
 * refused, `prefer` (fallible) is upgraded to `require`, explicit
 * `verify-full` is respected.
 */
export function productionProfileSsl(ssl: PgConnectOptions['ssl']): PgConnectOptions['ssl'] {
  if (ssl === 'disable') {
    throw new UsageError(
      '--production-profile: PG_DSN explicitly sets sslmode=disable — TLS is mandatory in the production profile',
    );
  }
  return ssl === 'verify-full' ? 'verify-full' : 'require';
}

/** Build the service options from a parsed config (exported for tests). */
export function buildOptions(config: Config): RegistryServiceOptions {
  if (Object.keys(config.tokens).length > 0) {
    // Token entropy floor (issue #120 item 7): the production profile
    // hard-fails on short static tokens, the default profile warns. This is
    // enforced HERE (startup, before anything binds) so the CLI and every
    // programmatic path through the options builder gets the same guarantee.
    assertTokenEntropy(config.tokens, { production: config.productionProfile });
  }
  if (config.productionProfile) {
    // The production profile is only honest when signing is actually
    // enforced (issue #48): unsigned publishes must not be accepted. This is
    // validated HERE (not just in parseArgs) so every path into the options
    // — CLI or programmatic — gets the same guarantee.
    if (Object.keys(config.signingKeys).length === 0) {
      throw new UsageError(
        '--production-profile requires at least one --signing-key (signed publishes are mandatory)',
      );
    }
    if (config.signingOptional) {
      throw new UsageError('--production-profile cannot be combined with --signing-optional');
    }
  }
  const options: RegistryServiceOptions = {
    driver: buildDriver(config),
    auth: {
      tokens: Object.keys(config.tokens).length > 0 ? config.tokens : undefined,
      oidc:
        config.oidc !== undefined
          ? { issuer: config.oidc.issuer, audience: config.oidc.audience, jwksUrl: config.oidc.jwksUrl }
          : undefined,
    },
    signing:
      Object.keys(config.signingKeys).length > 0
        ? { keys: config.signingKeys, mode: config.signingOptional ? 'optional' : 'required' }
        : undefined,
    host: config.host ?? DEFAULT_BIND_HOST,
  };
  if (config.productionProfile) {
    // Hardened defaults (issue #48): throttling on, signing required,
    // strict TLS for the postgres transport.
    options.rateLimit = { enabled: true };
    options.signing = { keys: config.signingKeys, mode: 'required' };
    if (config.driver === 'postgres') {
      const parsed = parseDsn(config.pgDsn!);
      parsed.ssl = productionProfileSsl(parsed.ssl);
      parsed.sslDefaulted = false;
      options.driver = new PostgresDriver({ options: parsed, auditRetentionDays: config.auditRetentionDays });
    }
  }
  return options;
}

function buildDriver(config: Config): StorageDriver {
  if (config.driver === 'postgres') {
    return new PostgresDriver({ dsn: config.pgDsn!, auditRetentionDays: config.auditRetentionDays });
  }
  return new InMemoryDriver();
}

function run(argv: string[]): number {
  let config: Config;
  try {
    config = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError && err.message === '__HELP__') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`bridge-registry-service: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  try {
    const options = buildOptions(config);
    if (config.auditFile !== undefined) {
      const driverBackend = options.driver;
      options.audit = {
        append: async (entry) => {
          await (driverBackend as { appendAudit(e: unknown): Promise<void> }).appendAudit(entry);
          await new FileAuditSink(config.auditFile!).append(entry);
        },
        query: async (filter) => (driverBackend as { queryAudit(f: unknown): Promise<unknown[]> }).queryAudit(filter) as never,
      };
    }
    // Issue #120 item 6: a non-loopback bind is always an explicit --host
    // decision — say so loudly BEFORE the socket opens.
    warnNonLoopbackBind(config.host);
    const server = start(options, config.port);
    server.on('error', (err) => {
      process.stderr.write(`bridge-registry-service: ${err.message}\n`);
      process.exit(1);
    });
    const shutdown = (): void => {
      server.close(() => process.exit(0));
      // Do not wait on idle keep-alive sockets (issue #48).
      server.closeIdleConnections();
      // Force-exit if graceful close still hangs (in-flight requests).
      setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    process.stderr.write(`bridge-registry-service: ${(err as Error).message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
