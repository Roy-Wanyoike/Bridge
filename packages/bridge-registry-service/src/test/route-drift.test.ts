/**
 * Route-drift guard (audit bonus item): every route the server actually
 * answers must be documented in the OpenAPI document, and vice versa. The
 * server's truth is the ROUTE_TEMPLATES table (which also feeds the
 * /metrics route labels), so a new route cannot ship undocumented — and the
 * document cannot promise routes the router does not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApiDocument } from '../openapi';
import { ROUTE_TEMPLATES } from '../server';

test('every server route appears in the OpenAPI document', () => {
  const documented = new Set(Object.keys(openApiDocument().paths as Record<string, unknown>));
  const missing = ROUTE_TEMPLATES.filter((route) => !documented.has(route));
  assert.deepEqual(missing, [], 'server routes missing from openApiDocument().paths');
});

test('every documented path is a real server route', () => {
  const documented = Object.keys(openApiDocument().paths as Record<string, unknown>);
  const available = new Set(ROUTE_TEMPLATES);
  const phantom = documented.filter((route) => !available.has(route));
  assert.deepEqual(phantom, [], 'openApiDocument().paths entries that the server does not implement');
});

test('the route table is de-duplicated and template-shaped', () => {
  assert.equal(new Set(ROUTE_TEMPLATES).size, ROUTE_TEMPLATES.length, 'no duplicate templates');
  for (const route of ROUTE_TEMPLATES) {
    assert.ok(route.startsWith('/'), `template starts with /: ${route}`);
    // Template parameters use OpenAPI {brace} syntax (never :colon), so the
    // same strings serve as /metrics labels and as openapi path keys.
    assert.equal(route.includes(':'), false, `no colon params in ${route}`);
  }
});
