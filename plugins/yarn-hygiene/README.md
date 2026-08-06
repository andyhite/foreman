# yarn-hygiene

Four tool-call interrupt rules for repositories whose package manager is
Yarn. They keep a foreign package manager out of the tree, keep `yarn.lock`
generated rather than authored, and make the install-time escape hatches an
explicit decision — including where Classic (v1) and Berry (v2+) spell the
same idea differently.

| Rule | Fires on | Point |
|---|---|---|
| `yarn-only` | `npm`/`pnpm`/`bun` subcommands, `npx`, `bunx` | A foreign install writes the wrong lockfile and layout. `yarn dlx` replaces `npx` on Berry; Classic has `yarn run <bin>` and `yarn create`. |
| `yarn-lockfile` | writes/edits to `**/yarn.lock` | Generated output in two incompatible formats. Resolve conflicts by re-running `yarn install`, which rewrites it deterministically. |
| `yarn-immutable-installs` | `--no-immutable`, `--no-lockfile`, `--pure-lockfile`, `YARN_ENABLE_IMMUTABLE_INSTALLS=false` | Berry's `--immutable` (CI default) and Classic's `--frozen-lockfile` exist to fail on a stale lockfile. Regenerate and commit it instead. |
| `yarn-integrity-overrides` | `yarn … --ignore-engines`/`--ignore-integrity`/`--ignore-scripts`/`--ignore-platform` | Engine and checksum checks found something real. `--ignore-scripts` is defensible only for auditing untrusted install scripts, and then you say so. |

Three of the four are scoped `tool:bash` with `interruptMode: tool-only`, so
they fire on actual shell execution — never on a `write`/`edit` that merely
*mentions* one of these commands in prose or a code block. `yarn-lockfile`
is the inverse: a glob condition on the file itself, so it fires when the
lockfile is about to be written or edited.

The `--ignore-*` condition is anchored to a `yarn` invocation on the same
command, and the flag conditions name Yarn-specific spellings, so they will
not trip on an unrelated tool that happens to share a flag name.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install yarn-hygiene@omp-foreman
```

Independent of the other plugins in this marketplace — install it alone, or
alongside any of them.
