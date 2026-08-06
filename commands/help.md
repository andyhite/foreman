---
description: Explain the foreman workflow — every command, skill, and agent, and when to use which
argument-hint: "[command | skill | agent] (empty = full overview)"
---

Orient me. If "$1" names a specific command, skill, or agent, skip the
overview and explain that one in depth instead: read its file, describe its
argument, where it sits in the lifecycle, which skills it reads, what it
leaves behind (board moves, branches, PRs), and show one worked
invocation.

Ground everything in the live tree, never from memory: list this
extension's `commands/*.md` and take each one's `description` frontmatter;
list `skills/*/SKILL.md` and `agents/*.md` the same way. If
`.omp/foreman.json` is missing, say so up front — most of this workflow is
inert until `/foreman:init` runs.

Present, compactly — tables over prose, one screen if you can:

1. **The lifecycle in one breath.** Ideas are recorded cheaply
   (`/foreman:record`), groomed into a task or an epic — or rejected
   (`/foreman:groom`), delivered (`/foreman:work <issue>` for a task or
   bug, `/foreman:orchestrate <epic>` for an epic), and land on the main
   branch only through a PR that **I** merge — the merge is the approval.
   Bugs enter through `/foreman:triage` with a severity label and skip the
   idea stage. `/foreman:report` snapshots the board without moving
   anything. `/foreman:init` is the one-time (or repair) setup step
   everything else depends on.
2. **Commands.** One row each: command, argument, what it does, and the
   moment you'd reach for it.
3. **Skills.** The operating manual behind the commands: which skill backs
   which command, and the ones read mid-task regardless of entry point
   (`tracker` for anything board-shaped, `worktree` before creating or
   removing one, `verification` before running checks, `stacked-prs` when
   an epic track chains).
4. **Agents.** What `planner`, `qa`, and `issue-worker` each do and who
   dispatches them.
5. **The rules that bite.** One issue, one branch, one worktree, one
   writer; claim before the first edit and keep the board current; agents
   never merge; a task is not done while its worktree exists.

Close with the one-line default: unsure where to start? `/foreman:report`
to see the board, then `/foreman:work` the top of `To Do` — or
`/foreman:init` first if the board doesn't exist yet.
