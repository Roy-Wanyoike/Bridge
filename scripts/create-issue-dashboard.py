#!/usr/bin/env python3
"""Create issue #93: dashboard live mode cannot fetch from the registry service."""
import json
import os
import urllib.request

REPO = 'Roy-Wanyoike/bridge'

body = """## Problem
The dashboard's **live mode** (the production default since PR #83) cannot fetch anything from a real `bridge-registry-service`. Verified at runtime: boot the service, publish a contract via the CLI over HTTP (works — `✓ published payments.v1@v1`), point a live-mode production build of the dashboard at it → every page lands in the error boundary (`error digest: 4157349472`).

Two independent contract breaks cause this:

### 1. Missing routes
`RestRegistryClient.listOrgs()` calls `GET /v1/orgs` and `listAllContracts()` calls `GET /v1/orgs/{org}/projects` — **neither route exists** on the service. The service's route table only defines `/v1/orgs/{org}/projects/{project}/…` paths (plus `/v1/search`, `/v1/audit`, `/v1/openapi.json`).

### 2. Unauthenticated reads
The dashboard client sends **no** `Authorization` header (`fetch` with only `accept: application/json`), and every `/v1` read on the service requires a bearer token — unauthenticated requests get `401 unauthenticated`. The service fails closed by design ("refuses to start unauthenticated"), so a no-token client can never read anything.

## Context
PR #50's verification of this client was **mock-fetch only** (its own header says "local evidence only"), and PRs #83/#84/#86 made live mode the production default — so the shipped product's primary UI cannot talk to its own backend. This is the last blocker in the CLI ⇄ service ⇄ dashboard loop.

## Requirement sources
- Conversation product spec: production-ready, user-onboardable platform.
- The service's own tenancy model: `principal.org` scopes every read; "another org's resources are indistinguishable from unknown ones (404 — never 403)".

## Current Behavior
Live-mode dashboard → error boundary on every page, even against a healthy, correctly-published registry service.

## Expected Behavior
A production deployment with `NEXT_PUBLIC_DEMO_MODE=false`, a registry URL and a service credential renders real contracts, diff reports, the dependency graph and the audit log.

## Proposed Direction (to be refined in the PR)
1. **Server-side credential**: the dashboard fetches server-side (dynamic routes); add a `REGISTRY_TOKEN` (server-only env, never `NEXT_PUBLIC_*`) that `RestRegistryClient` sends as `Authorization: Bearer …`. Fail fast in live mode when it is absent — same philosophy as the existing `RegistryMisconfigured` error.
2. **Discovery within the tenancy model**: since every credential is bound to exactly one org, replace `GET /v1/orgs` with either (a) env-declared org/projects (e.g. `REGISTRY_ORGS=acme:payments,commerce`) — the operator knows their deployment, no cross-tenant discovery needed — or (b) an auth-scoped `GET /v1/orgs` returning `{orgs:[{org: principal.org, projects: [...]}]}` derived from the driver. Prefer (a) for the dashboard (zero service change, no cross-tenant surface) plus (b) only if a service-side primitive is genuinely missing.
3. The audit page additionally needs an admin-role credential — document that requirement (403 surfaces honestly via the error boundary today).

## Scope
- `dashboard/src/lib/registry-client.ts` (auth header, discovery source, env handling)
- Dashboard README/env documentation
- Optionally `bridge-registry-service` if a scoped discovery route is preferred over env config

## Out of Scope
- Changing the service's fail-closed auth model
- Public/unauthenticated read routes (violates the tenancy no-leak design)

## Acceptance Criteria
- [ ] Live-mode production build against a real service renders: contracts list, contract detail, diff page, dependency graph, audit page — browser-verified, not mock-fetch
- [ ] The full journey works end to end: `bridge publish` (HTTP) → contract visible in the live dashboard
- [ ] Missing/invalid `REGISTRY_TOKEN` in live mode produces the honest, actionable misconfiguration error (never a silent demo fallback, never a bare digest)
- [ ] The token is never shipped to the browser bundle (grep the built client output)
- [ ] Dashboard tests updated: mock-fetch suites re-locked to the new request shape (auth header present, discovery per the chosen design)
- [ ] Demo mode remains fully functional (no regression)

## Validation Requirements
- Browser-based runtime validation against a live service (agent-browser or equivalent), including refresh persistence and error states
- Full dashboard suite + workspace regression

## Dependencies
- Builds on #91 (CLI HTTP publish — merged) for the end-to-end journey.

## Definition of Done
PR merged; live end-to-end publish → dashboard verified in the running application; regression green."""

req = urllib.request.Request(
    f'https://api.github.com/repos/{REPO}/issues',
    data=json.dumps({
        'title': 'fix(dashboard): live mode cannot fetch from the registry service — missing discovery routes and unauthenticated reads',
        'body': body,
        'labels': ['bug', 'dashboard'],
    }).encode(),
    method='POST',
    headers={
        'authorization': f"token {os.environ['GH_TOKEN']}",
        'content-type': 'application/json',
        'accept': 'application/vnd.github+json',
    },
)
with urllib.request.urlopen(req) as r:
    print(f"#{json.loads(r.read().decode())['number']} created")
