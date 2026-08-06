---
description: Turning off the immutable/frozen install lets a stale lockfile re-resolve silently — the drift it exists to catch becomes a green build
condition: '--no-immutable\b|--pure-lockfile\b|--no-lockfile\b|YARN_ENABLE_IMMUTABLE_INSTALLS=(0|false)\b'
scope: "tool:bash"
interruptMode: tool-only
---

An immutable install fails when `yarn.lock` does not already satisfy
`package.json`. That failure is the feature:

- **Berry (v2+) spells it `--immutable`,** and it is on by default whenever
  `CI` is set — so `--no-immutable` (or
  `YARN_ENABLE_IMMUTABLE_INSTALLS=false`) is an explicit opt-out of the
  check the pipeline depends on.
- **Classic (v1) spells it `--frozen-lockfile`,** and it is *not* the
  default: a plain `yarn install` will quietly update the lockfile. Berry
  rejects `--frozen-lockfile` and points you at `--immutable`.
- **`--pure-lockfile` (Classic) installs without writing the lockfile,**
  which hides the drift rather than recording it. **`--no-lockfile`
  (Classic) skips reading it as well,** giving an unpinned resolution that
  reproduces nowhere.
- **A failing immutable install is the finding, not the obstacle.** Install
  locally without the flag, read the resulting `yarn.lock` diff, commit it.
  The immutable install then passes on its own.

If the lockfile genuinely cannot be regenerated here, say that and stop —
disabling the check ships the drift to every environment that trusts it.
