---
name: research
description: Investigate a question against primary sources and capture the findings as a cited Markdown file. Read when a decision depends on external docs, API behavior, or library source nobody has read yet.
---

# Research — reading legwork you delegate, not skip

Dispatch a `scout` subagent to do the reading, so you keep working
while it investigates. Give it three jobs:

1. **Investigate against primary sources** — official docs, source
   code, specs, first-party APIs — never a secondary write-up of
   them. Follow every claim back to the source that owns it; a
   blog post repeating what the docs say is not the source, the
   docs are.
2. **Write the findings to a single Markdown file**, citing each
   claim's source. A finding without a citation is an opinion, not
   research, and can't be checked later when the question comes up
   again.
3. **Save it where the repo already keeps such notes.** Match the
   existing convention; if there is none, put it somewhere sensible
   and say where in the handoff.

The subagent's report is also readable at `agent://<id>` without
re-reading the file — use that when you only need the answer now and
the file is there for whoever needs it next.