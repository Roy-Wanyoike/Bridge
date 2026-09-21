#!/usr/bin/env python3
"""Close issue #87 with an honest retraction comment."""
import json
import os
import urllib.request

REPO = 'Roy-Wanyoike/bridge'
TOKEN = os.environ['GH_TOKEN']
N = 87

body = """Retracting this issue — the premise was wrong.

## What I claimed
That the `push`/`pull_request` branch filters were corrupted to `branches: ain]`, so pushes to main never triggered CI.

## What actually happened
The value in the committed blob is the **correct** `branches: [main]` list form. My earlier reads displayed the line inconsistently (several tool outputs rendered `[main]` as `ain]`), and I created this issue from those mangled observations without byte-independent verification.

## How it was settled (display-independent evidence)
The git blob SHA is computed on raw bytes, so comparing hashes cannot be affected by output rendering:

1. `git hash-object --stdin` of the actual line 5 bytes from blob `d5f65501c6d0d2d0aed55f3e6817e0510ae12038` → `36c265138e9ba0c567a6717c0bf91a40d19586b2`
2. Same hash of a locally byte-constructed correct list form (`branches: ` + 0x5B `main` 0x5D) → **identical**: `36c265138e9ba0c567a6717c0bf91a40d19586b2`
3. Hash of the hypothesized corrupted variant → different: `0a1796bb4777beda7a5c46bc44f0117f86a0397b`
4. The working-tree file, `HEAD` blob, and `origin/main` blob are all `d5f65501…` — one and the same content, everywhere.

Conclusion: the filter was always `branches: [main]`; PR-triggered runs (#88–#95) firing despite the "corruption" was the tell I should have questioned harder.

## Remaining true finding
The reason no run exists for merge commit 6924590, and the reason every 2026-09-04→09-09 run failed in ~2s with zero steps executed, is the account-level **GitHub Actions billing lock** — an owner-side billing setting, not a repository defect. Once lifted, pushes to main will trigger this workflow normally.

Closing as invalid. No code change was made (the branch for this fix had a zero-diff)."""

def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f'https://api.github.com/repos/{REPO}/{path}',
        data=data, method=method,
        headers={
            'authorization': f'token {TOKEN}',
            'content-type': 'application/json',
            'accept': 'application/vnd.github+json',
            'user-agent': 'bridge-audit',
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode() or '{}')

api('POST', f'issues/{N}/comments', {'body': body})
api('PATCH', f'issues/{N}', {'state': 'closed', 'state_reason': 'not_planned'})
print(f'#{N} closed as not_planned with retraction comment')
