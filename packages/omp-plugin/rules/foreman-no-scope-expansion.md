---
description: Catches an agent about to fix or touch something outside the issue's acceptance criteria while it's already in the area.
condition: "(?i)(while I['’]m here|while I am here|also fixed|while we['’]re (here|in here)|took the opportunity to|might as well|since I was in there|drive-by fix)"
scope: "text"
interruptMode: always
---

Stop. The acceptance criteria are the contract for this pass, not a floor.
Leave the extra work out of this diff, record it in `discoveredWork`, and let
the extension file it as a new issue.
