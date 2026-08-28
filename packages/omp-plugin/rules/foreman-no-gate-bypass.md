---
description: Catches an attempt to reach Linear's API from a shell or eval call, bypassing the extension's validated write path.
condition: "(?i)(api\\.linear\\.app|linear\\.app/graphql|LINEAR_API_KEY|issueUpdate|issueRelationCreate|issueLabelCreate|commentCreate)"
scope: "tool:bash, tool:eval"
interruptMode: tool-only
---

Stop. No agent holds a Linear write tool, and reaching the API through a shell
is the one path around that. State transitions, labels, relations, and comments
belong to the extension, applied from your validated structured result.

Put what you wanted changed into your result and yield. If it has no field for
it, that is the finding — say so in the result rather than routing around it.
