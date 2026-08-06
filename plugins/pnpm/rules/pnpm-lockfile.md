---
description: pnpm-lock.yaml is generated — a hand edit is overwritten by the next install and lies to everyone until then
condition:
  - "**/pnpm-lock.yaml"
interruptMode: tool-only
---

`pnpm-lock.yaml` is **output**, not source. Editing it by hand:

- Writes a resolution the resolver never produced. The next `pnpm install`
  discards it — but until then CI installs exactly what you typed, including
  versions and integrity hashes that were never verified against the registry.
- Desynchronizes the lockfile from `package.json`. pnpm records the manifest's
  declared ranges alongside each entry; a hand edit that satisfies one and not
  the other fails on the next install with a mismatch nobody expected.
- **Change it through the command that owns it:** `pnpm add <dep>` to
  introduce, `pnpm update <dep>` to move within range, `pnpm remove <dep>` to
  drop, plain `pnpm install` to reconcile after editing `package.json` directly.
- **Resolve merge conflicts by re-running install**, never by hand-merging
  YAML. Take either side whole, run `pnpm install`, commit the regenerated
  file. A hand-merged lockfile routinely describes a tree that matches no
  manifest on either branch.

Edit `package.json` and let pnpm write the lockfile — that is the only order
that produces a file the next install agrees with.
