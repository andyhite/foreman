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

1. **The lifecycle in one breath.** A document enters through
   `/foreman:intake`, single ideas still enter through `/foreman:record`, and
   both converge on `/foreman:groom`: they are groomed into a task or an epic
   — or rejected — before delivery (`/foreman:work <issue>` for a single
   task or bug, `/foreman:orchestrate` for an epic or, bare, the whole
   board — either way the orchestrating session provisions the worktrees
   its issue-workers deliver in), and land on the main
   branch only through a PR; under the default, **I** merge — the merge is
   the approval. Bugs enter through `/foreman:triage` with a severity label and skip
   the idea stage. `/foreman:report` snapshots the board without moving
   anything. `/foreman:init` is the one-time (or repair) setup step
   everything else depends on; `/foreman:doctor` is the maintenance pass
   that catches drift after init (renamed labels, edited board options,
   renamed scripts) — run it whenever a foreman skill's assumptions stop
   matching reality.
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
   writer; claim before the first edit and keep the board current; the
   operator merges unless the project configured otherwise; a task is not
   done while its worktree exists.

Close with the one-line default: unsure where to start? `/foreman:report`
to see the board, then `/foreman:work` the top of `To Do` — or
`/foreman:init` first if the board doesn't exist yet.
