---
description: Bun lockfiles are generated artifacts, never hand-edited — bun.lockb is binary and bun.lock only looks editable
condition:
  - "**/bun.lock"
  - "**/bun.lockb"
interruptMode: tool-only
---

That is Bun's lockfile. It is output, not source:

- **`bun.lockb` is a binary format.** Writing text into it does not edit it,
  it corrupts it — the next install either rejects the file or resolves a
  graph nobody intended.
- **`bun.lock` is text, so it only _looks_ editable.** It records resolved
  versions alongside integrity metadata Bun computed together; changing one
  version by hand describes a tree that was never actually resolved.
- **Both change only through Bun:** `bun add` / `bun remove` for an intended
  dependency change, `bun install` to sync the tree to `package.json`,
  `bun update [<dep>]` to move resolutions forward.
- **Bumping a version means editing `package.json`,** then running
  `bun install` and committing the lockfile diff Bun produces.
- **A merge conflict here is resolved by regenerating,** not by picking hunks:
  take either side, then `bun install` and commit the result.

The lockfile is committed because it is what makes installs reproducible and
what `--frozen-lockfile` compares against. To change what gets installed, open
`package.json` instead.
