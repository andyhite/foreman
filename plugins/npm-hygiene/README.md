# npm-hygiene

Four tool-call interrupt rules for repositories whose package manager is
npm. They keep a second lockfile out of the tree, keep `package-lock.json`
generated rather than hand-written, and make the resolver's escape hatches a
decision instead of a reflex.

| Rule | Fires on | Point |
|---|---|---|
| `npm-only` | `pnpm`/`yarn`/`bun` subcommands, `pnpx`, `bunx` | Each writes its own lockfile and resolves its own tree; two lockfiles mean CI and local disagree about what is installed. |
| `npm-lockfile` | Writing `package-lock.json` or `npm-shrinkwrap.json` | Entries carry `integrity` hashes — a hand-edited version or URL either fails verification or defeats it. Regenerate with npm. |
| `npm-ci-in-automation` | `npm install` / `npm i` (never `npm ci`) | `npm install` rewrites the lockfile and may resolve a newer tree. Automation and reproduction want `npm ci`. |
| `npm-peer-dep-escape-hatches` | `--legacy-peer-deps`, `--force`, `--omit=optional` on an npm invocation | They suppress the resolver's checks; the tree then breaks at runtime instead of at install time. |

The three command rules are scoped `tool:bash`, and every flag pattern is
anchored to an `npm` invocation on the same command — `git push --force`
does not trip them. `npm-lockfile` matches the file being written, so it
fires on an edit to the lockfile and not on prose that mentions it.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install npm-hygiene@omp-foreman
```

Independent of the other plugins in this marketplace — install it alone, or
alongside them, as the repo requires.
