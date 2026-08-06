---
description: In a workspace, pnpm add without --filter or -w either errors or writes the dependency into the wrong package.json
condition: '\bpnpm\s+(add|install|i)\b(?![^\n&|;]*(--filter|--workspace-root|\s-w\b))[^\n&|;]*\s(?!-)[\w@.]'
scope: "tool:bash"
interruptMode: tool-only
---

That command names a dependency but not the package it belongs to:

- In a workspace, pnpm refuses a root `add` outright (`--workspace-root` or
  `-w` is required) or, where that guard is off, records the dependency in the
  **root `package.json`** — a package that ships nothing and where the entry
  will not be found by whoever goes looking for it later.
- The result installs and passes locally anyway, because the root's
  `node_modules` is on the resolution path from the workspace packages. It
  breaks when the package that actually imports the dependency is built,
  published, or installed on its own.
- **Name the target package:** `pnpm add --filter <pkg> <dep>`, and
  `pnpm add --filter <pkg> -D <dep>` for a dev dependency.
- **Use `-w` deliberately**, not to silence the error — it is correct only for
  a genuine root-level tool: the formatter, the linter, the task runner, the
  types shared by every package's tsconfig.
- Already added to the wrong manifest? `pnpm remove -w <dep>` and re-add it
  with `--filter`; leaving a duplicate in both places is how versions drift.

The rule of thumb: if a single package imports it, `--filter` that package.
