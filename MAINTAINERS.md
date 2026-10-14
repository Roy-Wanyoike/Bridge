# Maintainers

The people currently responsible for the Bridge project and their areas of
ownership. How maintainers are added, replaced, or retired is defined in
[GOVERNANCE.md](GOVERNANCE.md) (succession and onboarding).

## Active

| GitHub handle | Role | Area of ownership |
|---------------|------|-------------------|
| [@Roy-Wanyoike](https://github.com/Roy-Wanyoike) | Project Lead (BDFL) | All areas — compiler, generators, registry-service, dashboard, docs |

Area ownership means reviewing PRs, building consensus on design, and being
accountable for tests and docs in the area. Areas map to the codebase as
follows: **compiler** → `packages/bridge-core`; **generators** →
`packages/bridge-generators`; **registry-service** →
`packages/bridge-registry-service` and `packages/bridge-registry`;
**dashboard** → `dashboard/`; **docs** → `docs/` and the root documents.
Until other maintainers are added, the Project Lead owns every area,
including the packages with no dedicated area yet
(`bridge-compat`, `bridge-serialization`, `bridge-ffi`, `bridge-lsp`,
`bridge-cli`).

## Emeritus

None yet. Former maintainers are listed here with their tenure and area
when they step down.
