# pnpm-hygiene

Four tool-call interrupt rules for repositories whose package manager is
pnpm. They defend the two things pnpm gets right and every other manager
gets differently: a lockfile that is generated, and an isolated
`node_modules` that only exposes what a package declares.

| Rule | Fires on | Point |
|---|---|---|
| `pnpm-only` | `npm`/`yarn`/`bun` subcommands, and `npx` | A competing manager writes the wrong lockfile and a flat tree that satisfies undeclared imports — the break surfaces only once someone installs correctly. |
| `pnpm-lockfile` | Writing/editing `pnpm-lock.yaml` | Generated output. Change it through `pnpm add`/`install`/`update`; resolve conflicts by re-running install, not by merging YAML. |
| `pnpm-frozen-lockfile` | `--no-frozen-lockfile`, `pnpm install --force` | Both turn a loud lockfile/manifest disagreement into a silent re-resolution, or hide a cache and integrity problem worth understanding. |
| `pnpm-workspace-root-install` | `pnpm add <dep>` with neither `--filter` nor `-w` | Names a dependency but not its package; it errors, or lands in the root manifest and resolves locally by accident. |

The three command rules are scoped `tool:bash` with
`interruptMode: tool-only`, so they fire on actual shell execution — never on
a `write`/`edit` that merely *mentions* one of these commands in prose or a
code block. `pnpm-lockfile` is a path rule and fires on the edit itself.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install pnpm-hygiene@omp-foreman
```

Independent of every other plugin in this marketplace — install it alone in
any pnpm repo, or alongside the others.
