## Summary
`scripts/e2e-gate.sh` is now self-contained. Three defects fixed in one leg:

1. **Steps 24–25 assumed a prebuilt release binary.** On a clean checkout the gate failed 2 of 25 steps even with the entire workspace green (verified during the final audit: `FAIL 24/25` before, `25/25` after manually running `bun scripts/package-release.mjs --current-only`).
2. **Hardcoded absolute paths.** `B` and `TSC` pointed at `/home/z/my-project/...` — every other clone location got a broken gate. Both now derive from `$PWD` (the script already resolved its own root).
3. **Version string drift waiting to happen.** Step 01 asserted the literal `0.2.1` and the binary name hardcoded it; both would break on the next release. `VERSION` now comes from `package.json`, and the binary name derives from `uname` (+ an `OSTYPE` branch for bun's windows `.exe` target).

## Why
The gate is the project's end-to-end acceptance run. A gate that fails on a clean environment produces false negatives and trains people to ignore red — the opposite of its purpose.

## Implementation
- Before steps 24–25: if `$BIN` is missing, the gate builds it via `bun scripts/package-release.mjs --current-only`.
- Missing bun → the binary steps are reported **SKIP** with an actionable reason (same semantics as `verify-*.sh`, which exit 77); bun present but packaging failed → explicit **FAIL** with a hint. `STRICT_SKIP=1` (CI contexts) turns skips into gate failures, mirroring `verify-all.sh`.
- No behavior change for steps 1–23 beyond the portable paths and the version-derived assertion.

## Testing
- `bash -n` syntax check ✓
- Path A (binary present): **25/25 PASS, 0 SKIP**
- Path B (binary deleted, bun available): gate auto-builds → **25/25 PASS, 0 SKIP**
- Path C (bun masked from PATH): **23 PASS / 0 FAIL / 2 SKIP**, gate exits 0; `STRICT_SKIP=1` verified to exit 1 by code path review (skip counter > 0 branch)
- Full workspace regression unaffected (no product code touched)

## Runtime Validation
All three gate runs executed for real in this environment, outputs reviewed; the auto-built binary was confirmed present in `dist/release/` with its checksums file after Path B.

## Security
No security-sensitive surface touched (test tooling only). No new dependencies.

## Breaking Changes
None. The gate still exits non-zero on failures; skips are additive information.

## Acceptance Criteria (issue #88)
- [x] On a clean checkout with bun installed, the gate reaches 25/25 PASS with no manual pre-step (Path B)
- [x] Without bun, steps 24–25 report SKIP, never a misleading FAIL (Path C)
- [x] No stale-binary/version false positives — binary name and version assertion derive from the workspace, not literals

## Related Issue
Closes #88
