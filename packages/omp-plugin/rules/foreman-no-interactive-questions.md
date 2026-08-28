---
description: Catches an agent starting to ask the operator a question in-session instead of yielding a BlockRecord.
condition: "(?i)(let me know|could you (confirm|clarify|tell me)|please (confirm|clarify|advise)|should I (proceed|continue)|which (option|approach) (do you|would you)|waiting (for|on) (your|the operator))"
scope: "text"
interruptMode: always
---

Stop. You cannot pause for approval — headless children have no approval UI,
so asking just stalls the run and burns budget. Yield a `BlockRecord` with
the question, your options, and your recommendation instead. The operator
reviews blocks in batch; they never watch you type.
