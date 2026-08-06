# git-hygiene

Rules for the git operations that can't be undone, and for keeping the default
branch clean. Nothing here knows about issue trackers, boards, or any
particular workflow — install it in any repo.

| Rule | Fires on | Point |
|---|---|---|
| `destructive-git` | `reset --hard`, `clean -fd`, `restore`/`checkout .`, `branch -D`, `stash drop`/`clear` | Read `git status` first; the dirty state may not be yours. Prefer recoverable moves. |
| `force-with-lease` | `git push -f` / `--force` without `--force-with-lease` | A lease failure is information about what moved on the remote, not an obstacle to escalate past. |
| `main-needs-a-pr` | `git push … main`/`master`, a local `git merge`, `gh pr merge --admin` | The default branch changes only through a merged pull request. No size of change earns a direct push. |
| `default-branch-is-read-only` | always — standing rule, no trigger | While the checkout is on the default branch, the tree is read-only. Branch *before* the first mutation. |

The first three are `tool:bash` interrupts with `interruptMode: tool-only`, so
they fire on actual shell execution — never on a `write`/`edit` that merely
*mentions* one of these commands in prose or a code block.

`default-branch-is-read-only` is different: it's a standing rule
(`alwaysApply: true`), so its content is injected into the system prompt rather
than triggered by a command. That's deliberate — rule conditions are regexes
matched against text, so no condition can ask "which branch is checked out?".
A prohibition on *all* mutation while on the default branch has to be a
standing instruction. The cost is a permanent slice of context; the benefit is
that it applies to the first `write` of a session, before any git command has
run.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install git-hygiene@omp-foreman
```

Independent of the other plugins in this marketplace — install any combination.

If you also install `foreman`, note that its `main-is-pr-only` rule overlaps
`main-needs-a-pr` here: foreman's version adds workflow-specific detail (who
merges, and where topic branches live). Both firing on one command is noisy but
harmless; if you run the foreman workflow, that plugin's rule is the more
specific one.
