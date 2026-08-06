---
description: This is a pnpm workspace — npm, yarn, and bun write the wrong lockfile and a flat node_modules that hides undeclared dependencies
condition: '\b(npm|yarn|bun)\s+(install|i\b|ci\b|add|remove|run|exec|dlx|test)\b|\bnpx\s'
scope: "tool:bash"
interruptMode: tool-only
---

This repository is a **pnpm workspace** — `packageManager` names pnpm and the
lockfile is `pnpm-lock.yaml`:

- `npm install` / `yarn add` / `bun add` write a competing lockfile and leave
  `pnpm-lock.yaml` stale, so tooling that reads the lockfile semantically to
  scope affected packages reasons about a graph nobody installed.
- **The layout difference is the dangerous part.** pnpm installs an isolated,
  symlinked tree where a package imports only what its own `package.json`
  declares. npm and yarn install a flat, hoisted tree where every transitive
  dependency is reachable from everywhere — so code silently satisfies imports
  it never declared and breaks only once someone installs correctly, or in CI.
- Adding a dependency: `pnpm add --filter <pkg> <dep>` — name the target
  package instead of landing it in the root by accident.
- Running a script: `pnpm <script>` at the root; one package only with
  `pnpm run --filter <pkg> <script>`.
- One-off binaries: `pnpm dlx <tool>`, never `npx` — `npx` fetches an
  unpinned version from the registry and ignores the workspace entirely.

A `package-lock.json` or `yarn.lock` showing up in a diff is an accident to
delete, not a second source of truth.
