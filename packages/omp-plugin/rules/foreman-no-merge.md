---
description: Catches an implementer about to merge its own PR or push straight to the base branch, which no agent has authority to do.
condition: "(?i)(gh\\s+pr\\s+merge|git\\s+merge(\\s|$)|git\\s+push[^\\n]*\\s(HEAD:)?(main|master)(\\s|$))"
scope: "tool:bash(*)"
interruptMode: tool-only
agents: foreman-implement
---

Stop. No agent has merge authority — that critical line is in your own
skill. Open or update the PR and yield your `ImplementResult`; the review
gate and the operator decide when this lands. Merging or pushing straight to
the base branch skips both.
