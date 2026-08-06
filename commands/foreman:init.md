---
description: Set up GitHub issue tracking for this repo under the foreman workflow (labels, project board, config)
argument-hint: "(empty = use the current repo and ask before creating anything new)"
---

Wire this repo into the foreman workflow. Read `skill://bootstrap`, then run
its procedure exactly: confirm the GitHub remote (create one only if I say
so), create the label vocabulary (skip labels that already exist), find or
create the GitHub Projects v2 board and its `Status` field with the six
standard options, resolve every ID, and write `.omp/foreman.json`.

Ask me, once, batched into as few questions as possible, only for decisions
the procedure can't make safely on its own: no remote at all (create vs.
point at an existing repo), an existing `Status` field whose options don't
match the standard six (map vs. leave it and use its own set), more than
one existing project board on the owner (which one).

Finish with: repo, project URL, labels created vs. already present, the
Status option IDs, and the path to the written config. If
`.omp/foreman.json` already exists, treat this as a repair pass — report
what already matched and what you fixed, not a fresh setup.
