---
description: This repository is a Bun workspace — npm, pnpm, yarn, and npx corrupt the lockfile and bypass the pinned toolchain
condition: '\b(npm|pnpm|yarn)\s+(install|i\b|ci\b|add|remove|run|exec|dlx|test)\b|\bnpx\s'
scope: "tool:bash"
interruptMode: tool-only
---

Bun is the package manager and the runtime here — `packageManager` pins the
Bun version and the lockfile is Bun's:

- **A competing manager writes the wrong lockfile** and the wrong
  `node_modules` layout. Two lockfiles in one tree are two dependency graphs,
  and the one CI installs from is not the one you tested.
- **Tooling that reads the lockfile semantically** — to scope which packages a
  change affects, or to key a build cache — cannot parse a foreign lockfile,
  so it degrades to "everything changed" or errors out.
- **Adding or removing a dependency:** `bun add <dep>` / `bun remove <dep>`,
  with `--filter <pkg>` in a workspace — never to the root by accident.
- **Running a script:** `bun run <script>` at the root; one workspace package
  only with `bun run --filter <pkg> <script>`.
- **One-off binaries:** `bunx <tool>`, not `npx`. `npx` fetches an unpinned
  version from the registry, so it runs whatever is latest today instead of
  the version this repo resolved.

CI installs with `bun install --frozen-lockfile`. Prose in older docs that
still says `npm`/`pnpm` is stale, not authority — the scripts in
`package.json` and the CI workflow definitions are.
