---
description: Do not force or unrecord a Bun install — --force re-resolves around the lockfile and --no-save installs what the next checkout will not have
condition: '\bbun\s+(install|i|add|update)\b[^\n]*?\s(--force|-f|--no-save)\b'
scope: "tool:bash"
interruptMode: tool-only
---

Those flags defeat the point of having a lockfile:

- **`--force` re-resolves and rewrites** instead of installing what was
  locked. It "fixes" a failing install by changing the dependency graph, so
  the tree you end up with is not the one anyone reviewed.
- **In automation the correct flag is the opposite one:**
  `bun install --frozen-lockfile` fails the build when `package.json` and the
  lockfile disagree — drift surfaces as a red check instead of as a different
  graph silently re-resolved on every machine.
- **`--no-save` installs a package without recording it.** It works here and
  nowhere else: the next clone, the next CI run, and every teammate get a tree
  missing that dependency, and the failure appears far from the cause.
- **Wanting a dependency means `bun add <dep>`** — with `--dev` or
  `--optional` when that is the right bucket — committing the `package.json`
  and lockfile diffs together.
- **A corrupt or half-written tree** is repaired by removing `node_modules`
  and running a plain `bun install`, not by forcing over it.

If the install is failing, that failure is the information — read it before
reaching for a flag that stops it being reported.
