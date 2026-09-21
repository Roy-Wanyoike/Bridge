## Summary
Removes 18 committed AI/agent development artifacts from `scripts/` (1,450 lines deleted). The repository now contains only durable product tooling.

## Why
The final-repository standard: every file must have a purpose in the product. These files were one-off plumbing from the audit/PR waves — they reference already-merged PRs, a deleted worktree, and one-off automation. Committed, they make the repo look like an agent development workspace and actively break: `verify-registry-client.mjs` crashed on every run as committed (its hardcoded `/home/z/my-project/worktrees/dash-ui/dashboard` path no longer exists), despite its own header saying "local evidence only, not committed".

## Removed
- `create-issues.mjs`, `audit-issues.mjs`, `create-labels.sh` — one-off issue/label bootstrapping
- `create-pr-41/42/49/50/51.mjs`, `create-pr-wave1/2/3.mjs` — per-PR upload scripts for merged PRs
- `issues-data-1/2.mjs`, `pr-body-49/50/51.md`, `pr45-body.md` — issue/PR content dumps for those PRs
- `verify-registry-client.mjs` — stale-path local-evidence script (crashes as committed)

## Kept (durable tooling)
`generate-all.mjs`, `generate-ffi.mjs`, `package-release.mjs`, `release-rehearsal.sh`, `e2e-gate.sh`, all `verify-*.sh`, `verify-demo-links.mjs`, `python_roundtrip.py`, `requirements-serialization.txt`.

## Testing
- Cross-reference check before removal: `git grep` for every removed filename across the tracked tree (excluding `scripts/`) — zero references.
- Full regression after removal: build ✓, lint 0 warnings ✓, **691/691 tests pass** ✓, e2e gate **25/25 PASS** ✓.

## Runtime Validation
The e2e gate was executed post-removal (the removal touches `scripts/` where the gate lives) — 25/25.

## Security
No secrets in any removed file (history scanned for token/key patterns — clean). Removal reduces surface, not adds.

## Breaking Changes
None — no tracked file referenced the removed scripts; no CI/verify step calls them.

## Acceptance Criteria (issue #89)
- [x] All 18 files are gone from the repo
- [x] No tracked file references them (verified)
- [x] Full regression still green: build, 691 tests, lint, e2e gate 25/25

## Related Issue
Closes #89
