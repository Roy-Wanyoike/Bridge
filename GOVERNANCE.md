# Governance

This document describes how the Bridge project makes decisions. It is
written for the project as it is today — a single-maintainer project — and
states the rules that take effect as maintainers are added, so the process
does not have to be invented under pressure. The current people are in
[MAINTAINERS.md](MAINTAINERS.md).

## Roles

| Role | Who | What it means |
|------|-----|---------------|
| Project Lead (BDFL) | [@Roy-Wanyoike](https://github.com/Roy-Wanyoike) | Owns the roadmap, breaks ties, cuts releases, and is the final escalation point for every decision. Today also the de-facto maintainer of every area. |
| Area maintainer | None yet — see [MAINTAINERS.md](MAINTAINERS.md) | Owns one area (compiler, generators, registry-service, dashboard, docs): reviews PRs in it, builds consensus on its design, and is accountable for its tests and docs. |
| Contributor | Anyone | Submits issues, PRs, and reviews per [CONTRIBUTING.md](CONTRIBUTING.md). Consistent, merged contributions in one area are the path to becoming its maintainer. |

## Decision-making

- **Default: consensus among the maintainers of the affected area.** With
  one maintainer of record, the Project Lead decides; the consensus rule is
  what replaces that as area maintainers are added.
- **Ties are broken by the Project Lead.** A tie means the maintainers of
  the affected area disagreed after real discussion — not that discussion
  was skipped.
- Decisions are recorded where the work happens: in the issue or PR that
  made them. If a decision changes documented behavior, the docs change in
  the same PR.

### Requires an issue discussion (RFC) before implementation

- Changes to the public IDL grammar, the canonical IR contract, or the
  diagnostics model (stable `BRxxxx` codes).
- Adding or removing a target generator language.
- Changes to the security model: authentication, signing, multi-tenancy,
  audit, or the security defaults of the registry service.
- Changes to this governance model, to who the maintainers are, or to the
  license.
- Breaking or removing a public CLI flag, exit code, or published package
  API.

Open an issue stating the problem and the proposed design, and let it
settle before code lands. This is the same rule
[CONTRIBUTING.md](CONTRIBUTING.md) already applies to larger changes.

### Does not require an issue discussion

Bug fixes, internal refactors, tests, documentation, tooling, and
performance work — anything that does not touch a public contract above.
Open the PR directly.

## Contribution flow

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) — it defines the bar every PR
   is held to (tests that fail without the change, deterministic generated
   code, docs updated with behavior).
2. Open an issue first if the change is in the RFC list above.
3. Submit the PR. Review requirements:
   - **When area maintainers exist**: two approvals for changes that create
     a new area (new package or generator target); the owning area
     maintainer's approval for changes within an existing area.
   - **Today, with a single maintainer**: the Project Lead reviews every
     PR. This is the acknowledged bottleneck — see below.
4. CI must be green. Merges happen only from reviewed PRs — never by direct
   push to `main`.

## Release management

- Versioning follows [Semantic Versioning](https://semver.org); the
  changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  in [CHANGELOG.md](CHANGELOG.md). Commits are conventional
  (`feat:` / `fix:` / `docs:` / …), and release bodies are rendered from
  them by git-cliff via [cliff.toml](cliff.toml).
- A release is one tag push, executed by the
  [release workflow](.github/workflows/release.yml) exactly as specified in
  [RELEASE.md](RELEASE.md). The pre-tag checklist there (version lockstep
  across root, every workspace package, `CLI_VERSION`, and the Homebrew
  formula) is mandatory and machine-enforced by the workflow's guard job.
- **Who cuts releases**: the Project Lead today. When the project adds
  maintainers, a release manager may be named in
  [MAINTAINERS.md](MAINTAINERS.md) per area-independent duty; releases are
  still cut only from a green `main`.
- Reality check: no release has been cut yet — CI is blocked by the Actions
  billing lock ([#127](https://github.com/Roy-Wanyoike/bridge/issues/127)).
  The first tagged release is a Project Lead responsibility until a release
  manager exists.

## Conduct and security

- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Reports go to the
  repository owner via GitHub; the Project Lead enforces it today.
- Security issues are **never** handled through public issues or this
  document. Follow [SECURITY.md](SECURITY.md) — private vulnerability
  reporting, a 72-hour initial-response target, coordinated disclosure. The
  Project Lead coordinates response today; area maintainers coordinate for
  their areas once they exist. Security-model changes also require the RFC
  path above.

## Succession and bus factor

This project currently has a single maintainer. That is a real risk — the
[production-readiness audit](docs/engineering/production-readiness.md)
names it directly — and it is treated as one:

- **Growing maintainers is the primary mitigation.** A contributor with
  sustained, merged work in one area can be nominated as its maintainer (by
  themselves or the Project Lead) through an issue; the appointment lands
  as a PR that adds them to [MAINTAINERS.md](MAINTAINERS.md) with their
  area of ownership. Onboarding: the new maintainer takes over review of
  their area under the rules above and co-reviews the first few PRs with
  the Project Lead.
- **Emeritus**: maintainers who step down are moved to the Emeritus section
  of [MAINTAINERS.md](MAINTAINERS.md) with thanks — not erased.
- **If the Project Lead is unresponsive** (no repository activity for six
  months and unreachable for 30 days across two contact channels):
  with two or more maintainers, they may appoint a new Project Lead by
  consensus. With none, the community may fork — the MIT
  [license](LICENSE) is the fallback governance.
- The bus-factor finding is closed only when a second maintainer is on
  record in [MAINTAINERS.md](MAINTAINERS.md). Until then, this document,
  the release automation, and the CI gates are the redundancy.

## Changing this document

Amendments to this file follow the rules it defines: issue discussion
first, consensus among maintainers (or the Project Lead's decision today)
on the record, change landed via PR.
