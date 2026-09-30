# Release engineering

This document is the operator's manual for cutting a Bridge release. The
process is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml);
a release is **one tag push** — but the pre-tag checklist below is mandatory,
and the workflow's first job (`guard`) fails the release if it was skipped.

## Prerequisites (one-time)

- GitHub Actions must be runnable on the account (⚠ see the billing note
  below — the workflows are complete but cannot execute until the account's
  Actions billing lock is lifted).
- `NPM_TOKEN` secret set for npm publishing. Without it the publish job runs
  `npm publish --dry-run` with a loud warning and **publishes nothing**; with
  it, a bad or unauthorized token fails the job (`npm whoami` preflight) and
  any publish error fails the release — nothing is masked.
- OIDC enabled for keyless cosign signing (default on GitHub Actions).

## Release checklist (per release)

1. Ensure `main` is green and the CHANGELOG reflects the release.
2. **Version lockstep** (enforced by the `guard` job):
   root `package.json` == every `packages/*/package.json` ==
   `CLI_VERSION` in `packages/bridge-cli/src/meta.ts` ==
   `homebrew/bridge.rb` `version` == the tag (`vX.Y.Z`).
3. Bump `homebrew/bridge.rb`: set `version "X.Y.Z"` and, once the release
   binaries exist, replace the four `sha256 :no_check` placeholders with the
   real per-target digests from that release's `checksums-sha256.txt`.
   (No PAT is wired up for auto-committing the formula — this is a manual
   checklist step, and the guard job enforces both halves of it: a formula
   version that does not match the tag, or any remaining
   `sha256 :no_check` placeholder, fails the release — `:no_check` would
   make `brew install` accept unverified binaries.)
4. Tag and push:
   ```bash
   git tag -a vX.Y.Z -m "Bridge vX.Y.Z"
   git push origin vX.Y.Z
   ```
5. The workflow then:
   - **guard**: asserts the version lockstep from step 2 (root, every
     workspace package, `CLI_VERSION` in `packages/bridge-cli/src/meta.ts`,
     Homebrew formula vs the tag) and refuses to ship a formula that still
     carries a `sha256 :no_check` placeholder;
   - builds **self-contained CLI binaries** for linux/darwin × amd64/arm64
     and windows/amd64 — the workflow inlines `bun build --compile` over
     `@bridge/cli` (scripts/package-release.mjs mirrors the same artifact
     layout for local runs; the workflow does not invoke it; bun is pinned
     to 1.2.23 so release binaries are reproducible) — and honestly
     smoke-tests the linux-amd64 binary (no `|| true`);
   - writes **SHA-256 checksums** (`checksums-sha256.txt`);
   - produces **SBOMs** (SPDX + CycloneDX) via syft;
   - **signs** every binary and the checksum file (keyless cosign, `.sig`
     files) and **attests** the checksums file with the SPDX SBOM as
     predicate (`cosign attest-blob --type spdxjson`, DSSE bundle saved as
     `checksums-sha256.txt.att`);
   - publishes a **GitHub release** with a conventional-commit changelog
     (`cliff.toml`, rendered by git-cliff — a render failure fails the job;
     the `|| fallback` in the body only covers an empty changelog, e.g. the
     first release);
   - builds **linux/amd64 + linux/arm64** container images, pushes each
     **by digest**, then merges them into a **true multi-arch manifest list**
     (standard buildx pattern) — verified in-workflow with
     `docker buildx imagetools inspect` asserting both platforms;
   - **signs the immutable manifest digest** (never a mutable tag);
   - **publishes the npm workspaces** — the publish list is derived from
     the workspace manifests (`packages/*/package.json`; currently nine
     public packages), never hardcoded — after asserting every published
     package's `dist/` exists.

## Container tags emitted

Exactly three tags are pushed to `ghcr.io/roy-wanyoike/bridge`:

| Tag | Meaning |
| --- | --- |
| `X.Y.Z` | bare semver (no `v` prefix) |
| `vX.Y.Z` | the versioned tag used in the verify commands below |
| `latest` | floating, points at the newest release |

All three point at the same multi-arch manifest list (linux/amd64 +
linux/arm64).

## Verifying a release

```bash
sha256sum --check checksums-sha256.txt
cosign verify-blob \
  --signature bridge-vX.Y.Z-linux-amd64.sig \
  --certificate-identity-regexp "https://github.com/Roy-Wanyoike/bridge/.github/workflows/release.yml" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  bridge-vX.Y.Z-linux-amd64
cosign verify ghcr.io/roy-wanyoike/bridge:vX.Y.Z
```

`cosign verify` resolves the `vX.Y.Z` tag to the signed manifest digest, so
the command above is valid for any of the three emitted tags (`X.Y.Z`,
`vX.Y.Z`, `latest`).

## Homebrew

[homebrew/bridge.rb](homebrew/bridge.rb) installs the release binaries
(`bin.install Dir["bridge-v#{version}-*"].first => "bridge"`, with a raise if
the glob misses). For a public tap: copy the formula into `homebrew-bridge/`
of your tap. **Bumping the formula `version` + pinning the `sha256` digests
is part of the per-release checklist above** — the release workflow's guard
job fails if the formula version does not match the pushed tag or if any
`sha256 :no_check` placeholder remains.

## Local dry-run (no CI needed)

```bash
bun scripts/package-release.mjs --current-only   # build + checksums
bash scripts/verify-release.sh                   # build, smoke, verify checksums
```

`scripts/verify-release.sh` fails (exit 1) if the binary is missing, the
smoke commands fail, or `checksums-sha256.txt` is absent/mismatched.

## ⚠ Billing note

GitHub Actions on this account is currently billing-locked: every workflow
in `.github/workflows/` is complete and correct but cannot execute until
the lock is lifted. All release mechanics above were additionally verified
locally where possible (binary build + smoke + checksums via bun; cliff.toml
rendered with git-cliff v2.10.0; cosign attest-blob flag/predicate shape
validated against cosign v2).
