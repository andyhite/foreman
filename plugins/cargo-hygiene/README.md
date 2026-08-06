# cargo-hygiene

Four tool-call interrupt rules for the Cargo operations that are permanent,
unreviewable, or quietly load-bearing. Nothing here assumes a crate layout, a
CI provider, or a release process — install it in any Rust repo.

| Rule | Fires on | Point |
|---|---|---|
| `cargo-lockfile` | a write or edit to `Cargo.lock` | Cargo owns that file. Binaries and workspaces commit it for reproducibility; a published library conventionally doesn't. Regenerate with `cargo add`/`cargo update -p`/`cargo build` — a hand edit desyncs it from `Cargo.toml` and fails a `--locked` build. |
| `cargo-blanket-update` | `cargo update` without `-p`/`--package` | It re-resolves the entire transitive graph into one diff nobody reads. Name the crate; if a full refresh is the point, give it its own commit and say why in the body. |
| `cargo-lint-suppression` | `--cap-lints allow`, `-A clippy::all` and other group allows, blanket `--allow warnings` on `cargo clippy`/`cargo build` | Command-line suppression leaves no trace in the tree. An inline `#[allow(...)]` with a reason, or a `[lints.clippy]` entry, reaches review. `--cap-lints allow` stays legitimate for vendored code you don't maintain. |
| `cargo-publish-is-irreversible` | `cargo publish` — never `--dry-run` | A crates.io version can be yanked but never replaced or deleted, so the number is spent and existing consumers keep the artifact. Dry-run first, then confirm the version bump and the packaged file list. |

The three command rules are scoped `tool:bash` with `interruptMode: tool-only`,
so they fire on actual shell execution — never on a `write`/`edit` that merely
*mentions* one of these commands in prose or a code block. `cargo-lockfile` is
a path rule: its glob condition scopes it to edits and writes of that file.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install cargo-hygiene@omp-foreman
```

Independent of every other plugin in this marketplace — install any of them,
all of them, or none.
