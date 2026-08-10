---
name: resolving-merge-conflicts
description: Resolve an in-progress merge or rebase by recovering each side's original intent from its commits, PRs, and issues. Read the moment a rebase or merge stops on a conflict.
---

# Resolving merge conflicts — recover intent, then reconcile it

1. **See the current state** of the merge or rebase. Check git
   history and the conflicting files. `read <file>:conflicts` lists
   every unresolved conflict block in a file without you scanning
   for `<<<<<<<` markers by eye.

2. **Find the primary sources** for each conflict. Understand deeply
   why each change was made and what the original intent was: read
   the commit messages, check the PRs, check the original issues or
   tickets. A conflict is two intents colliding — you can't reconcile
   them without knowing both.

3. **Resolve each hunk.** Preserve both intents where possible. Where
   they're incompatible, pick the one matching the merge's stated
   goal and note the trade-off — don't silently drop the other side.
   Never invent new behaviour to paper over the conflict. Always
   resolve; never `--abort`.

4. Discover the project's **automated checks** and run them —
   typically typecheck, then tests, then format. Fix anything the
   merge broke; a conflict resolved by eye but never checked is only
   half resolved.

5. **Finish the merge or rebase.** Stage everything and commit. If
   rebasing, continue the rebase process until every commit is
   rebased.