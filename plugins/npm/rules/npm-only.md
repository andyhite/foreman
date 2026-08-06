---
description: This repository is an npm project — pnpm, yarn, and bun write a second lockfile and resolve a different dependency tree
condition: '\b(pnpm|yarn|bun)\s+(install|i\b|add|remove|run|exec|dlx|test)\b|\b(pnpx|bunx)\s'
scope: "tool:bash"
interruptMode: tool-only
---

This project is managed by **npm** — `package-lock.json` is its lockfile and
npm is the only tool that maintains it:

- `pnpm` writes `pnpm-lock.yaml`, `yarn` writes `yarn.lock`, `bun` writes
  `bun.lock` — each resolves its own tree and its own `node_modules` layout.
- **Two lockfiles in one repo is the actual damage.** CI installs from
  `package-lock.json` while your local `node_modules` came from the other
  manager, so "works locally" and "fails in CI" stop being comparable, and
  tooling that reads the lockfile semantically to scope affected packages
  reads the wrong file or none.
- Adding: `npm install <pkg>` (`--save-dev` for tooling, `--workspace <pkg>`
  to land it in one workspace rather than the root). Removing:
  `npm uninstall <pkg>`, never a hand-deleted `package.json` entry.
- Scripts: `npm run <script>`; a single workspace with
  `npm run --workspace <pkg> <script>`, all of them with `--workspaces`.
- One-off binaries: `npm exec -- <bin>` or `npx <bin>`, not `pnpm dlx`,
  `yarn dlx`, or `bunx` — those resolve outside this project's tree.

A stray `pnpm-lock.yaml`, `yarn.lock`, or `bun.lock` in the tree is a fact to
raise, not permission to use that manager.
