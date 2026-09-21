/**
 * Usage and help text for the `bridge` CLI. Single source of truth for
 * `bridge help`, `bridge help <command>`, and bare/unknown invocations.
 */

export const GENERAL_USAGE = `bridge — one contract, every language. Bridge IDL command line interface.

Usage: bridge <command> [arguments]

Commands:
  init [dir]                      Scaffold a Bridge project
  validate [files...]             Compile contracts and report diagnostics
  fmt [-w] [files...]             Format Bridge IDL sources (canonical style)
  lint [files...]                 Report errors and convention findings
  generate --language <lang> [file]
                                  Generate Go/Rust/TypeScript/Python/Java/C# code
  diff <old-file> <new-file>      Human-readable compatibility report
  check <old> <new> | <file> --against <ref>
                                  Machine-oriented compatibility gate (CI)
  impact <contract> --to <ref>    Consumer-aware impact analysis: who is
                                  affected? (CI governance)
  publish <file> [options]        Publish a contract to a registry
                                  (local directory or HTTP service)
  pull <package> <version>        Fetch a published contract
  versions <package>              List published versions of a package
  inspect <package> [version]     Show metadata and shape of a contract
  search <query>                  Search published contracts
  doctor [--registry dir]         Check the environment
  version                         Print version information
  help [command]                  Show help for a command

Most commands accept input files; when none are given they fall back to the
"source" configured in bridge.json.

Exit codes: 0 success · 1 error (compile/check failures) · 2 usage error.

Run 'bridge help <command>' for details on a command.
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `bridge init [dir] [--minimal]

Scaffold a Bridge project in <dir> (default: the current directory).

Writes:
  <dir>/bridge.bridge   starter contract (payments example; minimal with --minimal)
  <dir>/bridge.json     project config { version, source, out }

Options:
  --minimal             scaffold a tiny starter contract instead of payments

Prints next steps. Refuses to overwrite existing files (exit 1).`,

  validate: `bridge validate [files...] [--json]

Compile each contract file and report diagnostics with source context.

On success prints:  ✓ <file> ok (package <name>, hash <short>)
On failure prints the compiler diagnostics (file:line:col, message, hint).

Options:
  --json                print a JSON array of
                        { file, ok, package?, hash?, diagnostics } instead;
                        exactly one entry per input file is always emitted —
                        a file that cannot be read reports ok: false with a
                        { severity: 'error', message } diagnostic

Exit 1 when any file fails to compile.`,

  fmt: `bridge fmt [-w] [files...]

Format Bridge IDL sources into the canonical style (4-space indent, one
field per line, sorted blank-line rules). Without -w prints a unified diff
of what would change and exits 1 when any file needs formatting.

Options:
  -w                    rewrite files in place instead of printing a diff

Exit 1 when a file cannot be parsed, or (without -w) when any file is not
already formatted.`,

  lint: `bridge lint [files...] [--strict]

Compile each file and report warnings and info findings (naming
conventions, deprecations, …) with file:line:col locations.

Options:
  --strict              also fail when only warnings/info are found

Exit codes: 0 clean (warnings tolerated by default); 1 when any error
(or, with --strict, any finding) is reported.`,

  generate: `bridge generate --language <go|rust|typescript|python|java|csharp>
                  [--out dir] [--package-name name] [--force] [file]

Compile a contract and generate a full language project from it.

The output directory defaults to <out from bridge.json, else "generated">
plus "/<language>" (e.g. generated/typescript). With --out the directory
is used exactly as given.

Options:
  --language <lang>     required: go | rust | typescript | python | java |
                        csharp
  --out <dir>           output directory (default generated/<language>)
  --package-name <name> override the derived module/package name
  --force               overwrite existing files

Prints every written path. Exit 1 on compile errors or when an existing
file would be overwritten without --force.`,

  diff: `bridge diff <old-file> <new-file> [--compatible]

Compile both contracts and print the human-readable compatibility report
(SAFE/WARNING/BREAKING/UNKNOWN changes, verdict, gate decision).

Options:
  --compatible          gate on definite breaking changes only (UNKNOWN
                        and WARNING verdicts pass)

Exit 1 when the check fails in the selected mode (default strict).`,

  check: `bridge check <old-file> <new-file> [--compatible] [--strict]
                [--format table|json|markdown]
bridge check <new-file> --against <ref-file|name@version> [--registry dir] […]

Machine-oriented compatibility gate for CI. The baseline is either the
first file or, with --against, a file or a published registry reference
('name@version', or 'name' for the latest version).

Gate (exit 1 when the verdict lands in the fail set):
  default        BREAKING and UNKNOWN changes fail
  --strict       additionally fails WARNING changes (full governance)
  --compatible   only definite BREAKING changes fail

Options:
  --against <ref>       baseline: file path or published name@version
  --registry <dir>      registry root for --against name references
  --format <fmt>        table (default) | json | markdown (PR-comment ready)
  --compatible          gate on definite breaking changes only
  --strict              also fail on warnings
  --json                shorthand for --format json; an explicit --format
                        wins when both are given

Exit 1 when the gate fails in the selected mode.`,

  impact: `bridge impact <contract> --to <name@version|file> [--registry dir]
              [--format table|json|markdown] [--strict]

Consumer-aware impact analysis: diff the contract against its baseline and
walk the registry's dependent graph transitively to answer "who feels this
change?". Every discovered consumer is reported with how the change reaches
it — a referenced type changed (directly or through an intermediate
contract), an event changed, the package was renamed — or why it is
unaffected. See docs/IMPACT.md for the reachability model and its limits.

'<contract>' and '--to' are each a file path or a published registry
reference ('name@version', or 'name' for the latest version). A path that
exists on disk wins over a registry name.

Options:
  --to <ref>            required: the candidate version to analyze
  --registry <dir>      registry root (default ./.bridge-registry, then
                        $BRIDGE_REGISTRY); a missing registry degrades the
                        report to the plain diff with a note
  --format <fmt>        table (default) | json (deterministic) | markdown
                        (GitHub PR-comment ready)
  --strict              exit 1 when any BREAKING change is detected

Exit 0 advisory by default; 1 with --strict on breaking changes or on
registry/compile failures; 2 on usage errors.`,

  publish: `bridge publish <file> [--registry dir|url] [--owner name]
                  [--description text] [--version vX]
                  [--org org] [--project project] [--token token]

Compile a contract and publish it to a registry — immutable and
content-addressed by the hash of its canonical IR.

Two registry kinds are supported:

1. Filesystem registry (default): the registry root defaults to
   ./.bridge-registry, overridden by the BRIDGE_REGISTRY environment
   variable, then by --registry.

2. HTTP registry service (a running bridge-registry-service): pass
   --registry with an http:// or https:// URL. Tenancy coordinates are
   required (--org, --project; or BRIDGE_ORG / BRIDGE_PROJECT) and the
   request is authenticated with a bearer token (--token or BRIDGE_TOKEN).
   The service records who published from the credential ('publishedBy'),
   so --owner (a filesystem-registry concept) is rejected for HTTP
   targets.

Options:
  --registry <dir|url>  registry root directory or HTTP(S) service URL
  --owner <name>        owning team or person (filesystem registries)
  --description <text>  searchable summary
  --version <vX>        explicit version for names without a version
                        segment (e.g. "payments" needs --version v1)
  --org <org>           organization (HTTP registries; or BRIDGE_ORG)
  --project <project>   project (HTTP registries; or BRIDGE_PROJECT)
  --token <token>       bearer token (HTTP registries; or BRIDGE_TOKEN)

Exit 1 when the version already exists with different content (versions
are immutable — publish a new version instead). Exit 2 on usage errors
(missing token or coordinates for HTTP registries).`,

  pull: `bridge pull <package> <version> [--registry dir|url] [--out file]
              [--org org] [--project project] [--token token]

Fetch a published contract version. Prints a summary of the stored
metadata and package shape; with --out writes the canonical JSON of the
package IR to a file instead.

With an HTTP(S) --registry URL the fetch goes to a running registry
service; tenancy coordinates (--org, --project) and a bearer token
(--token or BRIDGE_TOKEN) are required.

Options:
  --registry <dir|url>  registry root directory or HTTP(S) service URL
  --out <file>          write canonical IR JSON to this file
  --org <org>           organization (HTTP registries; or BRIDGE_ORG)
  --project <project>   project (HTTP registries; or BRIDGE_PROJECT)
  --token <token>       bearer token (HTTP registries; or BRIDGE_TOKEN)`,

  versions: `bridge versions <package> [--registry dir|url]
              [--org org] [--project project] [--token token]

List all published versions of a package, oldest to newest, marking the
latest. Exit 1 when nothing is published under that name.

With an HTTP(S) --registry URL the listing comes from a running registry
service; tenancy coordinates (--org, --project) and a bearer token
(--token or BRIDGE_TOKEN) are required.`,

  inspect: `bridge inspect <package> [version] [--registry dir|url]
              [--org org] [--project project] [--token token]

Show the metadata and shape of a published contract: hash, publisher,
description, type/method/event counts and imports. Without a version the
latest is inspected.

With an HTTP(S) --registry URL the metadata comes from a running registry
service; tenancy coordinates (--org, --project) and a bearer token
(--token or BRIDGE_TOKEN) are required.`,

  search: `bridge search <query> [--registry dir|url] [--token token]

Substring search (case-insensitive) over published package names,
descriptions and publishers. Empty results exit 0.

With an HTTP(S) --registry URL the search runs on a registry service,
scoped to the authenticated credential's organization (a bearer token is
required via --token or BRIDGE_TOKEN).`,

  doctor: `bridge doctor [--registry dir]

Environment diagnostics: node version, workspace package resolution,
compiler and generator smoke test (a minimal schema is compiled and
generated), and registry directory existence/writability.

Prints one ✓/✗ line per check; exit 1 when any check fails.`,

  version: `bridge version

Print the CLI version, generator version and node version.`,

  help: `bridge help [command]

Print the general usage text, or detailed help for one command.`,
};
