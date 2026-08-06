---
description: yarn.lock is generated, not authored — a hand-edit or a hand-merged conflict hunk produces an install nobody else can reproduce
condition:
  - "**/yarn.lock"
interruptMode: tool-only
---

`yarn.lock` is output. It is committed so every machine resolves the same
tree, and Yarn is the only thing that writes it:

- **The two formats are different artifacts.** Classic (v1) writes a bespoke
  format headed `# yarn lockfile v1`; Berry (v2+) writes YAML with a
  `__metadata` block and `resolution:`/`checksum:` entries. Neither is
  hand-editable, and porting entries between them corrupts both.
- **Change dependencies through the CLI** — `yarn add`, `yarn remove`,
  `yarn up` (Berry) or `yarn upgrade` (Classic). The lockfile updates as a
  side effect, with the transitive graph re-resolved.
- **Resolve conflicts by re-installing, not by picking hunks.** Both
  versions parse a conflicted `yarn.lock` and reconcile the two sides, so
  `yarn install` on the conflicted file usually just works; otherwise take
  one side wholesale (`git checkout --ours`/`--theirs yarn.lock`) and
  install. Either way Yarn rewrites the file deterministically.
- **An unexplained checksum change is a signal.** A new integrity hash for a
  version you did not touch deserves an answer before it lands.

Reading the diff is the job; editing it is not. If the lockfile looks wrong,
fix the input in `package.json` and re-run the install.
