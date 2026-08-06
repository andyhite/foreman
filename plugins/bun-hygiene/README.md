# bun-hygiene

Three tool-call interrupt rules for repos where Bun is the package manager and
the runtime. They keep a foreign package manager, a hand-edited lockfile, and a
forced install out of a tree whose reproducibility depends on all three.

| Rule | Fires on | Point |
|---|---|---|
| `bun-only` | `npm`/`pnpm`/`yarn` with `install`, `i`, `ci`, `add`, `remove`, `run`, `exec`, `dlx`, `test`, and any `npx` | A competing manager writes the wrong lockfile and `node_modules` layout. Use `bun add`, `bun run`, and `bunx` — `npx` fetches unpinned versions. |
| `bun-lockfile` | writing or editing `bun.lock` / `bun.lockb` | `bun.lockb` is binary, so a text edit corrupts it; `bun.lock` is text and therefore only *looks* editable. Both change only via `bun add`/`bun install`/`bun update`. |
| `bun-frozen-lockfile` | `bun install --force` / `-f`, or `--no-save` | `--frozen-lockfile` is the automation flag — drift should fail the build, not re-resolve. `--no-save` installs what the next checkout will not have. |

`bun-only` and `bun-frozen-lockfile` are scoped `tool:bash`, so they fire on
actual shell execution — never on a `write`/`edit` that merely *mentions* one
of these commands in prose or a code block. `bun-lockfile` is the inverse: it
fires on the file write, not on talking about it. All three use
`interruptMode: tool-only`.

Install this only in repos that really are Bun-based; in a pnpm or npm repo
`bun-only` would fire on every correct command.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install bun-hygiene@omp-foreman
```

Independent of every other plugin in this marketplace — install it alone, with
some, or with all of them.
