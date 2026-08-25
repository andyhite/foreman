# Foreman

Foreman is a repo with two Foreman plugins. `herdr/` is a herdr plugin shipping
the `foreman` CLI — the mechanism that creates worktrees, spawns peer coding
agents, and carries reports and questions between them. The repo root is an
omp-native agent plugin (`package.json`, `.omp-plugin/plugin.json`,
`.mcp.json`, `command-prompts/`, `skills/`, `extension/`).
`extension/index.ts` reads `command-prompts/*.md` at load and registers each
as a `foreman:<name>` slash command — not left to omp's own file-based command
discovery, which does not namespace commands from a link/git-installed plugin
the way it does for a marketplace-installed one.

omp discovers a plugin's capabilities by scanning conventional paths under its
root, not by reading fields out of `.omp-plugin/plugin.json`. Two consequences
bit this repo, in opposite directions: `commands/` is scanned, which is why the
slash-command sources live in `command-prompts/` and the extension registers
them itself; and `.mcp.json` is scanned, which is why the bus is declared
there. A `mcpServers` field in the manifest is carried as metadata and starts
nothing — v0.6.0 shipped the bus declared that way, so no sidecar ever spawned
and every delivery silently took the `herdr agent prompt` fallback. Verify a
capability by observing it (`omp -p` in a scratch directory, then look for the
process), never by reading the manifest back.

## Verify

Run every suite under the oldest supported bash — several shipped bugs only
reproduce there:

```sh
/bin/bash herdr/test/foreman-test.sh        # macOS system bash 3.2
/bin/bash herdr/test/foreman-link-test.sh
/bin/bash herdr/test/foreman-dashboard-test.sh
```

shellcheck with `-s bash` for `herdr/bin/foreman`, `herdr/bin/foreman-dashboard`
and the test files, `-s sh` for `foreman-link`, `foreman-ls`,
`foreman-dashboard-open`, and `install.sh`. CI runs exactly this plus a
version-consistency check.

## Shell constraints

- `herdr/bin/foreman` and the tests are bash 3.2: no associative arrays, no
  `${var,,}`, no `$EPOCHREALTIME`. `foreman-link`, `foreman-ls`, and `install.sh`
  are POSIX sh — no bashisms at all.
- Glob ranges in `case` patterns need `local LC_ALL=C` first: locales
  interleave case in collation order, so under macOS bash 3.2 `[a-z]` matches
  `W`. `valid_handle` and `valid_skill_name` show the pattern.
- Dispatch/report counters are compared as strings, never numerically:
  "never dispatched" (no file) and "dispatched zero times" must compare equal.
  Related: `test -nt` compares whole seconds on bash 3.2, which is why the
  freshness protocol uses counters instead of mtimes.
- Wall-clock bounds are absolute deadlines computed up front (`deadline_ms`),
  never accumulated sleep intervals — loop bodies block on herdr calls that
  carry their own timeouts.

## House conventions

- Comments justify decisions: each one names the bug it prevents or the
  alternative it rejects, not what the line does. Match this in every edit.
- Every test in `foreman-test.sh` is a bug that actually shipped. A new fix
  lands with the regression test that would have caught it.
- Root-level command/skill prose is omp-native; skills are referenced as
  `skill://<name>` everywhere — the sweep test in `foreman-test.sh` fails any
  `foreman skill` reference left in that prose or the README.
- One version string, three files: `herdr/herdr-plugin.toml`,
  `.omp-plugin/plugin.json`, and `package.json` must agree (CI enforces).
  `foreman version` reads the toml at runtime.
- Both plugins share the name `foreman` with the GitHub repo — coincidence, not
  an install-time namespace; there is no marketplace here, so nothing keys an
  install on it.
- Handles (`[a-z][a-z0-9_-]{0,31}`) are the only worker identifiers; all state
  lives under `$FOREMAN_STATE` keyed by handle, and nothing is written into the
  repo a worker operates on. Workspace and pane IDs stay inside the CLI.
