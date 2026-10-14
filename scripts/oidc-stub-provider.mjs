#!/usr/bin/env node
/**
 * Minimal OIDC stub provider (issue #163 E2E verification).
 *
 * Serves discovery, an auto-consenting authorize endpoint and a token
 * endpoint against a running console. The console must complete a full
 * authorization-code + PKCE round-trip against this stub:
 *
 *   GET  /.well-known/openid-configuration
 *   GET  /authorize?...state&nonce&code_challenge&redirect_uri   -> 302 callback?code&state
 *   POST /token            -> { id_token } (echoes the captured nonce)
 *
 * Deliberately lenient (no real consent UI) but state/nonce-aware, so the
 * console's own validation is what is actually exercised.
 *
 * Usage: node scripts/oidc-stub-provider.mjs <port>
 */

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';

const port = Number(process.argv[2] ?? 4460);
const ISSUER = `http://localhost:${port}`;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const kid = 'stub-key-1';
const jwk = publicKey.export({ format: 'jwk' });
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' });

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Captured authorizations: state -> { nonce, challenge, clientId, redirectUri } */
const pending = new Map();

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function makeIdToken({ iss, sub, aud, nonce }) {
  const header = b64urlJson({ alg: 'EdDSA', typ: 'JWT', kid });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlJson({ iss, sub, aud, nonce, name: 'Stub User', email: 'stub@example.com', iat: now, exp: now + 600 });
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${Buffer.from(sig).toString('base64url')}`;
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        jwks_uri: `${ISSUER}/jwks.json`,
      });
    }
    if (url.pathname === '/jwks.json') {
      return Response.json({ keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, alg: 'EdDSA', use: 'sig' }] });
    }
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const code = 'stub-code-' + Math.random().toString(36).slice(2, 10);
      pending.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
        method: url.searchParams.get('code_challenge_method'),
        clientId: url.searchParams.get('client_id'),
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { location: back.href } });
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      const code = form.get('code');
      const auth = pending.get(code);
      if (!auth) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      pending.delete(code);
      // Verify the PKCE binding ourselves: the console must send the right verifier.
      const digest = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (digest !== auth.challenge) {
        return Response.json({ error: 'invalid_grant', error_description: 'pkce mismatch' }, { status: 400 });
      }
      return Response.json({
        access_token: 'stub-access-token',
        id_token: makeIdToken({ iss: ISSUER, sub: 'stub-user-1', aud: auth.clientId, nonce: auth.nonce }),
        token_type: 'Bearer',
      });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`[stub-oidc] issuer ${ISSUER} listening on :${server.port}`);
