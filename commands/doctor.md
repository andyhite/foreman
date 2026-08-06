---
description: Check .omp/foreman.json for drift against live GitHub/repo state, repair what's safe, flag what isn't
---

Run a drift check. Read `skill://doctor`, then run its procedure exactly:
gather every finding read-only first (labels, board identity, status role
mapping, repo conventions, board hygiene), apply only the unambiguous
repairs (cosmetic renames, a re-detected command that still resolves),
and ask me before touching anything ambiguous (a vanished board-option
ID, a project that no longer resolves, a config value that looks like a
deliberate hand-edit).

If `.omp/foreman.json` doesn't exist yet, tell me to run `/foreman:init`
instead — there's nothing to check drift against.

Finish with a table: check → finding → action taken (or the question
still open). If everything's clean, say so in one line instead of padding.
