`policy.worktree.strategy: provided` selects this strategy. Use it when the harness gives the session its worktree and owns its lifecycle; this strategy validates that handoff instead of making a second checkout.

## claim-check

A second session can still be working the issue elsewhere. Gather, without
creating anything: the issue's board status (`skill://tracker`) and the
remote branch picture:

```sh
git fetch origin
git branch -a | grep '<issue>-' || true
```

Then assert by role:

- **Orchestrating session, before claiming:** the status is not
  `In Progress` and the branch check printed nothing. Claim through
  `skill://tracker` only after this passes; `create` then validates the
  harness handoff.
- **Dispatched worker:** the status is `In Progress`, and the only
  `<issue>-` branch is the one your brief names — the branch of the
  harness-provided checkout. Anything else goes back to your orchestrator.

## create

This is an assertion, not a no-op. Check, in order:

1. The cwd is inside a git worktree:

   ```sh
   git rev-parse --is-inside-work-tree | grep -x true
   ```

2. It is not the primary checkout:

   ```sh
   PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
   CURRENT=$(git rev-parse --show-toplevel)
   test "$CURRENT" != "$PRIMARY"
   ```

   Refuse loudly when this fails. A misconfigured provided strategy otherwise
   silently turns the operator's checkout into the worktree.

3. The tree is clean:

   ```sh
   test -z "$(git status --porcelain)"
   ```

4. The branch is `<type>/<issue>-<slug>`. This strategy may **create** that
   branch, never rename or move one — the harness's branch and any existing
   branch of the target name both belong to someone else. Resolve exactly one
   of three cases:

   ```sh
   WANT=<type>/<issue>-<slug>
   HAVE=$(git branch --show-current)   # empty on a detached head

   if [ "$HAVE" = "$WANT" ]; then
     :                                  # already correct — accept, change nothing
   elif git show-ref --verify --quiet "refs/heads/$WANT"; then
     echo "refuse: $WANT already exists and is not checked out here" >&2; exit 1
   elif [ -z "$HAVE" ]; then
     git switch -c "$WANT"              # detached head — name it, destroys nothing
   else
     echo "refuse: worktree is on $HAVE, not $WANT" >&2; exit 1
   fi
   ```

   Never reach for `git branch -M` here. It force-overwrites an existing
   destination branch, so on a caller-supplied worktree it can rename your
   branch over another session's work — the one-writer rule broken by the
   strategy meant to uphold it. A name collision is a `claim-check` question,
   and a wrongly-named branch is a harness misconfiguration; both are stops
   for the operator, not repairs to attempt.

5. Dependencies exist; when they do not, install them:

   ```sh
   test -d node_modules || test -d vendor || <commands.install>
   ```

Return `$PWD` and `<type>/<issue>-<slug>`.

## remove

Report that the caller owns the lifecycle. This is a genuine no-op: delete
nothing, because this strategy did not create the directory.

```sh
printf '%s\n' 'Provided worktree lifecycle remains with the caller; nothing removed.'
```

## unwind

Nothing here is yours to tear down: the checkout, its branches, and its
state belong to the harness — this strategy deletes nothing, the same
boundary its `remove` keeps. On a failed handoff (a `create` assertion
that refused, or an install that failed), stop touching the checkout,
release the claim — status back to `To Do`, failure commented on the
issue — and report the failed handoff to the operator, naming the
`<type>/<issue>-<slug>` branch ref if the assertion created one before
failing, so the harness can reset or discard it deliberately.

## scratch-create

Scratch checkouts remain plain git because they are detached, throwaway,
agent-only checkouts rather than harness-provided issue worktrees:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin
git -C "$PRIMARY" worktree add --detach "$PRIMARY/../<name>" <ref>
```

## scratch-remove

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" worktree remove "$PRIMARY/../<name>"
```
