---
name: worktree
description: Contract for foreman worktrees: invariant discipline and named operations whose mechanics come from the configured strategy. Read before creating, using, or retiring issue or scratch worktrees.
---

# Worktrees — one issue, one branch, one worktree, one writer

Every issue has one branch, one worktree, and one writer. The primary checkout
belongs to the operator: never switch its branch and never edit in it.

A worktree is **yours to write in** by exactly one of three routes: you
created it through `create`; the harness handed it to you and `create`
accepted it (see the `provided` strategy); or your orchestrator
provisioned it and named it in your brief. On that last route writing is
yours but retirement is not — whoever ran `create` runs `remove`. Every
other worktree is another session's in-flight work and is read-only —
never edit, install into, build in, or remove one. Ownership is what the
one-writer rule is about, and creation is only the commonest way to
acquire it.

## Naming

Derive `<repo-slug>` from `.omp/foreman.json#repo` (the part after `/`), or
from the primary checkout directory name when that file does not exist yet.

| Thing | Pattern |
| --- | --- |
| Branch | `<type>/<issue>-<slug>` |
| Issue worktree | `<repo-slug>-<issue>-<slug>` |
| Track worktree | `<repo-slug>-<epic>-<track-slug>` |
| Scratch checkout | `<repo-slug>-<epic>-integration` |

`<type>` comes from `.omp/foreman.json#commitTypes`; stay inside that allowed
set. `<slug>` is the issue title in lower-kebab, trimmed to a handful of words.
Use no characters that break a Windows checkout: kebab only.

## Operations

| Operation | Contract |
| --- | --- |
| `claim-check <issue>` | Report the issue's claim state — board status plus any existing `<issue>-` branch or worktree — without creating anything. Read-only. The orchestrating session, before claiming, requires *unclaimed*: not `In Progress`, no `<issue>-` artifacts. A dispatched worker requires the claim to *match its brief*: `In Progress`, and exactly the worktree and branch it was handed — anything else goes back to the orchestrator. |
| `create <issue> <type> <slug>` | Produce a worktree for the issue at the conventional path, on a new branch off `origin/<mainBranch>`, with dependencies installed. Return the worktree path and branch name. |
| `remove <issue>` | Retire the worktree and its local branch after the PR merged. Refuse a dirty tree. |
| `unwind <issue>` | Tear down what a **failed** `create` left behind — a partial worktree and a commit-free branch — so the claim can be released. Only valid for a provision that never received a worker; it proves the branch carries no commits before destroying anything. `remove` stays reserved for merged work. |
| `scratch-create <name> <ref>` | Produce a detached, throwaway, agent-only checkout of a ref for integration verification or diffing. It is not an issue worktree and never gets a workspace, pane, or agent. |
| `scratch-remove <name>` | Retire a scratch checkout. |

Call an operation by name; do not put a creation or removal mechanism in a
caller.

## Work inside it

Every git operation inside a worktree — commit, rebase, and push — is ordinary
git regardless of how the worktree was made. Only creation and removal are
provenance-sensitive, which is why this discipline belongs in the contract
rather than a strategy.

- Do edits, installs, checks, and commits inside the worktree.
- Keep the branch fresh with `git rebase origin/<mainBranch>`, never `git merge`.
- Push with `git push -u origin <branch>`; after a rebase use
  `git push --force-with-lease`, never bare `--force`.

### When the rebase conflicts

Use `skill://resolving-merge-conflicts`. Resolve the conflict; never `--abort`,
because that discards the information you just recovered. Never invent behavior
to make a hunk compile: recover each side's intent from its commits and PRs,
and when they are genuinely incompatible, choose the behavior matching the
rebase's goal and say so.

## Resolve the mechanism

`policy.worktree.strategy` in `.omp/foreman.json` selects the mechanism;
when that key or the whole `policy` block is absent, use `git`. Read
`skill://worktree/strategies/<strategy>.md`. When the value contains `/` or
ends in `.md`, read that repo-relative path instead. A value naming neither a
shipped strategy nor a resolvable path is a hard stop: run `/foreman:doctor`;
never silently fall back to `git`.
