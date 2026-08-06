# shell-safety

Five tool-call interrupt rules for shell operations that are
irreversible, over-privileged, or destructive before they even run.
Nothing here assumes a language, a toolchain, or any particular workflow —
install it in any repo.

| Rule | Fires on | Point |
|---|---|---|
| `recursive-force-delete` | `rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force` (flags in any order) | No trash, no undo, and the blast radius is whatever the variable expanded to — echo the path, name it, never glob it. |
| `sudo-changes-the-blast-radius` | `sudo` | It leaves the project for machine state, where nothing is version-controlled. Nearly every in-repo need has a non-sudo path. |
| `world-writable-permissions` | `chmod 777`/`666`/`a+rwx`/`o+w`, including recursive | A debugging shortcut that gets committed. Fix ownership instead; `755` for executables and directories, `644` for files. |
| `pipe-to-shell` | `curl`/`wget` piped into `sh`/`bash`/`zsh`/`sudo bash` | Unreviewed remote code with your privileges, and the server can serve the inspecting fetch something else. Download, read, run. |
| `truncating-redirect` | `>` into a path with a source-code extension (never `>>`) | `>` empties the file before the command runs, so a failure leaves it blank. Content changes belong in an editor or a patch. |

All five are scoped `tool:bash` with `interruptMode: tool-only`, so they
fire on actual shell execution — never on a `write`/`edit` that merely
*mentions* one of these commands in prose or a code block.

The conditions are anchored on the tool name rather than on shared
flags, which keeps them quiet: `--force` alone would trip on every
`git push --force`, so `recursive-force-delete` instead requires both a
recursive and a force flag on an actual `rm`. `truncating-redirect`
deliberately does not match `>>`, `>=`, `->`, or `2>&1`.

Nothing here duplicates git: `git reset --hard`, `git clean -fd`, and
force pushes belong to the sibling `git-hygiene` plugin, which owns
them. Install both for full coverage of destructive commands.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install shell-safety@omp-foreman
```

Independent of every other plugin in the same marketplace — install
this one alone, alongside the others, or not at all.
