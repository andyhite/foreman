---
description: Set up GitHub issue tracking for this repo under the foreman workflow (labels, project board, and this repo's own conventions in .omp/foreman.json)
argument-hint: "(empty = use the current repo and ask before creating anything new)"
---

Wire this repo into the foreman workflow. Read `skill://bootstrap`, then run
its procedure exactly: confirm the GitHub remote (create one only if I say
so), create the label vocabulary (skip labels that already exist), find or
create the GitHub Projects v2 board and its `Status` field with the six
standard options, resolve every ID, detect this repo's own conventions
(main branch, allowed commit types, package manager and install command,
check/verify/e2e scripts) rather than assuming any of them, install the
companion rule packs this repo's toolchain and contents actually call for
(project scope, one package-manager pack only, registering the marketplace
first if it isn't already), and write it all to `.omp/foreman.json`.

Ask me, once, batched into as few questions as possible, only for
decisions the procedure can't make safely on its own: no remote at all
(create vs. point at an existing repo), an existing `Status` field whose
option names don't match the standard six roles (map vs. leave it and use
its own set), more than one existing project board on the owner (which
one), more than one lockfile present (which package manager is
authoritative).

Finish with: repo, project URL, labels created vs. already present, the
status role → option-name → ID mapping, and every detected convention with
**which were detected vs. guessed vs. left null** — say plainly which
values you're confident in and which are a starting guess worth
double-checking. Then the rule packs: installed, skipped (with the evidence
for each), and whether the detected package manager has no pack yet. Tell me
to `/reload-plugins` if anything was installed — the rules aren't live in
this session until then. If `.omp/foreman.json` already exists, treat this as
a repair pass: report what already matched and what you fixed or filled in,
not a fresh setup, and never overwrite a value that looks like a deliberate
hand-edit.
