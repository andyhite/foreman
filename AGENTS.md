# Foreman

Foreman is the marketplace; Fleet is what it publishes. `herdr/` is a herdr
plugin shipping the `fleet` CLI — the mechanism that creates worktrees, spawns
peer coding agents, and carries reports and questions between them.
`plugins/fleet/` is an omp-native agent plugin whose commands and skills
teach an orchestrator to drive that CLI.
`.omp-plugin/` at the root is the marketplace manifest that publishes the
plugin tree under the name `foreman`.

## Verify

Run every suite under the oldest supported bash — several shipped bugs only
reproduce there:

```sh
/bin/bash herdr/test/fleet-test.sh        # macOS system bash 3.2
/bin/bash herdr/test/fleet-link-test.sh
/bin/bash herdr/test/fleet-dashboard-test.sh
```

shellcheck with `-s bash` for `herdr/bin/fleet`, `herdr/bin/fleet-dashboard`
and the test files, `-s sh` for `fleet-link`, `fleet-ls`,
`fleet-dashboard-open`, and `install.sh`. CI runs exactly this plus a
version-consistency check.

## Shell constraints

- `herdr/bin/fleet` and the tests are bash 3.2: no associative arrays, no
  `${var,,}`, no `$EPOCHREALTIME`. `fleet-link`, `fleet-ls`, and `install.sh`
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
- Every test in `fleet-test.sh` is a bug that actually shipped. A new fix
  lands with the regression test that would have caught it.
- plugins/fleet prose is omp-native; skills are referenced as `skill://<name>`
  everywhere — the sweep test in `fleet-test.sh` fails any `fleet skill`
  reference left in plugin prose or the root README.
- One version string, four files: `herdr/herdr-plugin.toml`,
  `plugins/fleet/.omp-plugin/plugin.json`, `.omp-plugin/marketplace.json`, and
  `plugins/fleet/package.json` must agree (CI enforces). `fleet version` reads
  the toml at runtime.
- Two names, deliberately: `foreman` is the marketplace (named for this
  repository), `fleet` is the plugin inside it and the CLI. The install target
  is `fleet@foreman`. Do not introduce a third name, and do
  not rename the marketplace again lightly — the name keys existing installs
  (`fleet@<marketplace>` in omp's `installed_plugins.json`), so changing it
  forces everyone to re-add the marketplace and reinstall.
- Handles (`[a-z][a-z0-9_-]{0,31}`) are the only worker identifiers; all state
  lives under `$FLEET_STATE` keyed by handle, and nothing is written into the
  repo a worker operates on. Workspace and pane IDs stay inside the CLI.
