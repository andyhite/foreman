---
description: Record an idea as a GitHub issue (idea label, Backlog)
argument-hint: "<idea text>"
---

Record an idea in the tracker. The idea, as given:

$ARGUMENTS

If that is empty, ask what the idea is before doing anything.

Read `skill://tracker` (run `/omp-foreman:init` first if `.omp/foreman.json`
doesn't exist yet), then: distill a plain-sentence title in this repo's
existing issue-title style, keep the body faithful to the note as given (an
idea is a recorded intention, not a spec — do not embellish it into a
proposal; add at most a line of context or a file/doc reference if one is
obviously implied), create the issue with the idea label, add it to the
board at `Backlog`.

Reply with the issue URL and the title you chose — nothing else.
