---
name: verification
description: The foreman verification ladder — cheapest-first feedback while implementing, package/workspace-scoped checks after a slice, and the full pre-PR gate. Read before running checks so you run the smallest thing that answers the question. Detects the project's own tooling instead of assuming a stack.
---

# Verification — run the smallest thing that answers the question, in this project's own tooling

Three rungs. Climb only when the current rung is green; never open with the
full suite. This skill does not assume any specific package manager, test
runner, or monorepo tool.

**Check the cache first.** `.omp/foreman.json#commands` (written by
`/foreman:init`, or updated by a previous run of this skill) holds this
repo's own `packageManager`, `install`, `check`, `verify`, and `e2e`
commands when they were detectable. If a value is present there, use it
directly instead of re-detecting. If it's absent, `null`, or turns out to
be wrong (the script was renamed, the command 404s), detect fresh below —
and if you're the one who fixes it, write the corrected value back to the
config so the next session skips the same rediscovery.

Detecting from scratch takes thirty seconds:

- `package.json#scripts` (root, and, in a workspace, the affected package's)
  — look for `verify`, `check`, `test`, `lint`, `typecheck`, `build`, `e2e`
  by name.
- A `Makefile`/`justfile` with equivalent targets, for non-Node projects.
- A monorepo tool (`turbo.json`, `nx.json`, `lerna.json`,
  `pnpm-workspace.yaml`, `go.work`) that scopes checks to affected
  packages — use its filtering instead of running the whole repo every time.
- CI config (`.github/workflows/*.yml`) — it's the ground truth for what
  "green" means to this project; mirror it, don't guess past it.

If none of that resolves a rung below, ask rather than inventing a command.

## Rung 1 — while implementing (seconds)

Per file, after each edit:

- **Types:** LSP diagnostics on the touched files (`lsp` tool,
  `diagnostics` with a path or glob) — typecheck-grade feedback with no
  build.
- **Lint:** the project's linter on just the touched file (`eslint <file>`,
  `ruff check <file>`, `golangci-lint run <file>` — whatever the repo
  actually uses).
- **One test file:** the project's test runner scoped to the file you're
  changing (`vitest run <path>`, `bun test <path>`, `pytest <path>`, `go
  test ./pkg/...`).

TDD shape: write the test, watch it fail for the right reason, implement,
watch it pass. A test that never failed proves nothing.

Do **not** run e2e, whole-package suites, or repo-wide anything on this
rung.

## Rung 2 — after a slice (a minute or two)

When a coherent step of the plan is done, check the affected package(s)
using the monorepo tool's own filtering (so its graph orders build/typecheck
correctly), or the repo-wide check script if there's no monorepo tool:

```sh
# monorepo, example: turbo
<pm> check --filter=<affected-package>
# single-package repo
<pm> run check   # or whatever script name this repo actually uses
```

If typecheck and build share one output directory (common with `tsc -b` or
similar incremental builders), never run two of them concurrently in one
package by hand — use one tool invocation that orders them, or run them one
at a time.

## Rung 3 — the pre-PR gate (before every PR, after every review fix)

1. Format check (whatever formatter the repo uses) on touched files; most
   repos also enforce this repo-wide via a pre-commit hook — don't fight it,
   satisfy it.
2. The repo's full verification script — usually named `verify` or `ci`,
   sometimes just `check` run without a `--filter`. Fix what it finds; do
   not scope it down at this rung.
3. **E2E when it applies:** if the repo has an e2e/integration suite and the
   change touches a surface it covers, build first if the suite needs a
   built artifact, then run it. First run on a fresh machine may need a
   one-time browser/driver install step (e.g. `playwright install
   --with-deps`).
4. **Exercise the change.** A green verification script shows nothing
   broke — not that what you built works. Run the actual surface: start the
   dev server plus the browser tool for UI, a real invocation for APIs and
   CLIs, the repro steps for a bug fix. The observed behavior is the proof;
   name it in your report.

## CI expectations

Read `.github/workflows/*.yml` (or the repo's CI config) once per project
and note: what runs on every push vs. only on affected paths, whether e2e is
gated, and whether flaky tests retry (they shouldn't — a retry turns a flake
into a green check with a note nobody reads; file a flaky test as a bug
instead of re-running it to green, per `bug-triage`).
