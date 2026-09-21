#!/usr/bin/env python3
"""Open a PR with a structured body (title, head, base given on argv)."""
import json
import os
import sys

REPO = 'Roy-Wanyoike/bridge'
title, head = sys.argv[1], sys.argv[2]
body = sys.stdin.read()

req = urllib = None
import urllib.request
req = urllib.request.Request(
    f'https://api.github.com/repos/{REPO}/pulls',
    data=json.dumps({'title': title, 'head': head, 'base': 'main', 'body': body}).encode(),
    method='POST',
    headers={
        'authorization': f"token {os.environ['GH_TOKEN']}",
        'content-type': 'application/json',
        'accept': 'application/vnd.github+json',
    },
)
try:
    with urllib.request.urlopen(req) as r:
        j = json.loads(r.read().decode())
    print(f"PR #{j['number']}: {j['html_url']}")
except urllib.error.HTTPError as e:
    print(f'HTTP {e.code}: {e.read().decode()[:500]}')
    sys.exit(1)
