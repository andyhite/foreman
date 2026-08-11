`policy.worktree.strategy: git` selects this strategy. Use it when ordinary git owns the checkout lifecycle; it is the default and preserves foreman's existing mechanics.

## claim-check

Gather, without creating anything: the issue's board status
(`skill://tracker`) and any existing claim artifacts:

```sh
git branch -a | grep '<issue>-' || true
```

Then assert by role:

- **Orchestrating session, before claiming:** the status is not
  `In Progress` and the branch check printed nothing — a hit means the
  issue is already claimed; stop rather than create a second writer.
  Claim through `skill://tracker` only after this passes, then `create`.
- **Dispatched worker:** the status is `In Progress`, and the only
  `<issue>-` branch is the one your brief names, backed by the worktree
  you were handed. Anything else — no claim, a different branch, a
  second worktree — goes back to your orchestrator.

## create

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin <mainBranch>
git -C "$PRIMARY" worktree add "$PRIMARY/../<repo-slug>-<issue>-<slug>" \
  -b <type>/<issue>-<slug> origin/<mainBranch>
cd "$PRIMARY/../<repo-slug>-<issue>-<slug>"
<commands.install>   # from .omp/foreman.json#commands.install — node_modules/vendor
                     # dirs are per-worktree, and this also wires any git hooks
```

Return `$PRIMARY/../<repo-slug>-<issue>-<slug>` and
`<type>/<issue>-<slug>`.

## remove

After the PR merged and the issue is `Done`:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
cd "$PRIMARY"
git worktree remove ../<repo-slug>-<issue>-<slug>
git branch -d <type>/<issue>-<slug>
git worktree prune
```

`git worktree remove` refusing a dirty tree is information, not an obstacle to
`--force`: inspect the uncommitted work first.

## unwind

Tear down a `create` that failed partway, before any worker was
dispatched. First prove there is nothing to lose — the branch must carry
no commits beyond its base:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" log --oneline origin/<mainBranch>..<type>/<issue>-<slug>  # must print nothing
```

Anything printed means this is not a failed provision — stop and look.
Then, skipping any step whose artifact was never created:

```sh
git -C "$PRIMARY" worktree remove --force "$PRIMARY/../<repo-slug>-<issue>-<slug>"
git -C "$PRIMARY" branch -D <type>/<issue>-<slug>
git -C "$PRIMARY" worktree prune
```

`--force` and `-D` are correct **only here**: the tree holds nothing but a
failed install's debris, and the branch was proven commit-free above.
`remove` (above) is for merged work and never force-deletes.

## scratch-create

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin
git -C "$PRIMARY" worktree add --detach "$PRIMARY/../<name>" <ref>
```

A scratch checkout is reusable across landings: fetch, then run
`git -C "$PRIMARY/../<name>" checkout --detach <ref>`.

## scratch-remove

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" worktree remove "$PRIMARY/../<name>"
```
