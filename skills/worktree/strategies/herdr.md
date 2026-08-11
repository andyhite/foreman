`policy.worktree.strategy: herdr` selects this strategy. Use it when the issue worktree will be occupied by a person or another agent and therefore needs a herdr workspace, rather than merely a directory.

`herdr worktree create` produces a workspace: sidebar entry, tab, pane, setup
hooks that copy `.env*` and run `mise trust` / `direnv allow`, and possibly an
`omp`. That apparatus gives its occupant somewhere to work. The process that
creates it cannot move its own shell there; a pane move changes its display,
not its cwd. Do not create a workspace for a checkout you will only address by
path: it would add an idle second agent burning tokens. With `HERDR_ENV` unset,
this strategy cannot work; that is a `/foreman:doctor` finding, not a reason to
silently downgrade to `git`.

## claim-check

Gather, without creating anything: the issue's board status
(`skill://tracker`) and both herdr and git state:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
herdr worktree list --cwd "$PRIMARY"
git -C "$PRIMARY" branch -a | grep '<issue>-' || true
```

Then assert by role:

- **Orchestrating session, before claiming:** the status is not
  `In Progress`, and no herdr worktree or `<issue>-` branch matches — a
  hit means the issue is already claimed. Claim through `skill://tracker`
  only after this passes, then `create`.
- **Dispatched worker:** the status is `In Progress`, and the matching
  herdr worktree and branch are exactly the ones your brief names.
  Anything else goes back to your orchestrator.

## create

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin <mainBranch>
herdr worktree create --cwd "$PRIMARY" \
  --branch <type>/<issue>-<slug> \
  --base origin/<mainBranch> \
  --path "$PRIMARY/../<repo-slug>-<issue>-<slug>" \
  --no-focus
cd "$PRIMARY/../<repo-slug>-<issue>-<slug>"
<commands.install>
```

`--path` preserves the sibling convention; `--no-focus` leaves the operator
where they were. Return the path and `<type>/<issue>-<slug>`.

## remove

Read the workspace id from `.result.worktrees[].open_workspace_id`; removal
takes that id, never a path:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
herdr worktree list --cwd "$PRIMARY"   # find this tree's open_workspace_id
herdr worktree remove --workspace <id>
```

Do not use `git worktree remove` on a herdr-created worktree: it deletes the
checkout and orphans the workspace, leaving its sidebar entry and occupant
homeless. `herdr worktree remove --workspace <id>` is safe for any worktree
that has a workspace, however it was created.

## unwind

Tear down a `create` that failed partway. `herdr worktree create` may have
made the workspace before the failure — check, and when a workspace
exists, remove through herdr so no orphan survives:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
herdr worktree list --cwd "$PRIMARY"    # this tree's open_workspace_id, if any
herdr worktree remove --workspace <id>
```

No workspace (a null `open_workspace_id`, or the failure predates herdr's
work): use the git mechanics instead — prove the branch commit-free
(`git -C "$PRIMARY" log --oneline origin/<mainBranch>..<branch>` prints
nothing), then `git worktree remove --force`, `git branch -D`,
`git worktree prune`, skipping any step whose artifact was never created.

## scratch-create

A scratch checkout lasts less than the task, so it must not get a workspace, a
pane, setup hooks, or an idle second agent. Create it with plain git:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin
git -C "$PRIMARY" worktree add --detach "$PRIMARY/../<name>" <ref>
```

Herdr still shows it in `herdr worktree list` with a null `open_workspace_id`:
it is unmanaged, not invisible.

## scratch-remove

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" worktree remove "$PRIMARY/../<name>"
```
