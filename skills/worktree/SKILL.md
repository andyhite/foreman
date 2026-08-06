---
name: worktree
description: Creating, using, and cleaning up git worktrees for issue work under the foreman workflow — naming conventions, setup, and the discipline that keeps concurrent sessions from corrupting each other. Read before creating a branch or worktree, and before removing one.
---

# Worktrees — one issue, one branch, one worktree, one writer

Every piece of issue work happens in its own worktree, a sibling of the
primary checkout, on its own branch. The primary checkout belongs to the
operator: never switch its branch, never edit in it. A worktree you did not
create belongs to another session: read-only, always.

## Naming

Derive `<repo-slug>` from `.omp/foreman.json#repo` (the part after the `/`)
or, if that file doesn't exist yet, the primary checkout's directory name.

| Thing    | Pattern                       | Example                             |
| -------- | ------------------------------ | ------------------------------------ |
| Branch   | `<type>/<issue>-<slug>`        | `fix/291-actor-identity-gate`        |
| Worktree | `<repo-slug>-<issue>-<slug>`   | `../myapp-291-actor-identity-gate`   |

- `<type>` is a Conventional Commit type. `.omp/foreman.json#commitTypes`
  (written by `/omp-foreman:init`, detected from this repo's commitlint config
  where one exists) is the allowed set — stay inside it. Bugs are `fix/`;
  tasks take whatever type fits the change.
- `<slug>` is the issue title, lower-kebab, trimmed to a handful of words.
- No colons or other characters that break a Windows checkout — kebab only.

## Create

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin <mainBranch>
git -C "$PRIMARY" worktree add "$PRIMARY/../<repo-slug>-<issue>-<slug>" \
  -b <type>/<issue>-<slug> origin/<mainBranch>
cd "$PRIMARY/../<repo-slug>-<issue>-<slug>"
<commands.install>   # from .omp/foreman.json#commands.install — node_modules/vendor
                      # dirs are per-worktree, and this also wires any git hooks
```

Before creating, check nobody beat you to it: the issue must not already be
`In Progress`, and `git branch -a | grep <issue>-` must come up empty. Claim
the issue (status `In Progress`, `tracker` skill) before your first edit.

## Work inside it

- Everything — edits, installs, checks, commits — happens inside the
  worktree.
- Keep the branch fresh against `origin/<mainBranch>` with `git rebase
  origin/<mainBranch>` (never `git merge`); resolve conflicts locally, in the
  worktree.
- Push with `git push -u origin <branch>` (`--force-with-lease` after a
  rebase, never bare `--force`).

## Clean up — yours, and only after the work landed

A task is not complete while its worktree still exists. After the PR is
merged and the issue is `Done`:

```sh
cd "$PRIMARY"
git worktree remove ../<repo-slug>-<issue>-<slug>
git branch -d <type>/<issue>-<slug>
git worktree prune
```

`git worktree remove` refuses a dirty tree — that refusal means uncommitted
work exists; look at it before reaching for `--force`.

Never remove, edit, install into, or build inside a worktree another session
created — its dirty state is someone's in-flight work.
