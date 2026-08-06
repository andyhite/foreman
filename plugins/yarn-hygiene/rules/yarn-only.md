---
description: This repository uses Yarn — npm, pnpm, bun, and npx write the wrong lockfile and bypass the resolution Yarn recorded
condition: '\b(npm|pnpm|bun)\s+(install|i\b|ci\b|add|remove|run|exec|dlx|test)\b|\b(npx|bunx)\s'
scope: "tool:bash"
interruptMode: tool-only
---

The package manager here is **Yarn**: the lockfile is `yarn.lock`, and
`packageManager` in `package.json` (or a `.yarnrc.yml`) says whether this is
Berry (v2+) or Classic (v1).

- **A foreign install writes the wrong lockfile.** `npm install` emits
  `package-lock.json`, `pnpm add` emits `pnpm-lock.yaml`, `bun install`
  emits `bun.lock` — each with a different `node_modules` layout, and
  tooling that reads the lockfile semantically to scope affected packages
  stops seeing the truth. CI installs from `yarn.lock`.
- **Dependencies:** `yarn add <dep>` / `yarn remove <dep>`, and in a
  workspace `yarn workspace <name> add <dep>` — never the root by accident.
  Upgrades are `yarn up <dep>` on Berry, `yarn upgrade <dep>` on Classic.
- **Scripts:** `yarn <script>` at the root; one package only with
  `yarn workspace <name> <script>`.
- **One-off binaries:** Berry's `yarn dlx <pkg>` is the direct `npx`
  replacement. Classic has no `dlx` — `yarn run <bin>` executes what is
  already in `node_modules/.bin`, and `yarn create <starter>` scaffolds.

Both lines write a file called `yarn.lock`, but the formats and the install
flags differ — confirm the major version before copying a command verbatim.
