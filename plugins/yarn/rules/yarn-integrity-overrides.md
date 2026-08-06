---
description: yarn --ignore-* flags suppress compatibility and supply-chain checks that already found something — the failure moves to runtime, it does not go away
condition: '\byarn\b[^\n;|&]*--ignore-(engines|integrity|scripts|platform)\b'
scope: "tool:bash"
interruptMode: tool-only
---

Each of these silences a check that just fired:

- **`--ignore-engines`** defers a declared Node/OS incompatibility to
  runtime. Move the toolchain to a supported version instead of trading a
  precise install error for an obscure later crash.
- **`--ignore-integrity`** turns off checksum verification against the
  lockfile. That is a supply-chain control, not a nuisance — a mismatch says
  the bytes you fetched are not the bytes that were locked. Find out why
  before routing around it.
- **`--ignore-platform`** installs artifacts built for another OS or CPU:
  the install succeeds and the native binary fails to load.
- **`--ignore-scripts`** has exactly one honest use — auditing an untrusted
  dependency's lifecycle scripts before you let them run. Take it for that,
  and say so out loud; an unexplained `--ignore-scripts` reads as skipping a
  build step the project needs, and the tree it leaves behind is incomplete.

These are Classic (v1) flags. Berry (v2+) dropped them for `.yarnrc.yml`
settings (`checksumBehavior`, `enableScripts`) and
`yarn install --mode=skip-build` — the same decision in a different
spelling, owed the same justification.
