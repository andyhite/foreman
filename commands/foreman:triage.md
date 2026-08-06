---
description: File and triage a bug (severity label, board routing)
argument-hint: "<bug report> | <issue-number> (empty = sweep untriaged bugs)"
---

Triage a bug report. The report, as given:

$ARGUMENTS

Read `skill://bug-triage` and `skill://tracker`, then run the triage
procedure end to end: search for duplicates (open and closed) first; then
either comment the new evidence on the existing issue or file a new one
with the severity rubric applied — `bug:sevN` label, added to the board,
routed (top severities → To Do, lower severities → Backlog).

If the report above is an issue number rather than a description, triage
that existing issue instead: reproduce, apply the rubric, swap `bug` for
`bug:sevN`, route it. If it is empty, sweep every open issue labeled plain
`bug` the same way.

Reply with: the issue URL, the severity and one-line justification, where
it was routed, and any duplicate/regression linkage found. A `sev0` gets
said loudly, first.
