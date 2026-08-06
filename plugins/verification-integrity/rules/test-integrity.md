---
description: Never narrow or soften the test suite to get green — no stray .only/.skip, no retries, no blind snapshot updates
condition: '\.(only|skip)\s*\(|\bretries:\s*[1-9]|--update-snapshots|\b[xf](it|describe|test)\s*\('
scope: "tool:bash"
interruptMode: tool-only
---

That change narrows or softens the test suite. The bar:

- **`.only` never lands.** It silently shrinks the suite to one case;
  remove it before committing.
- **A `.skip` is a tracked decision**, not a mute button: it carries a
  comment naming the issue that will unskip it. Skipping a test your change
  broke is presenting unfinished work as done.
- **E2E/integration suites stay `retries: 0`** by design where the project
  sets that — a retry turns a flake into a green check with a note nobody
  reads. A flaky test is a bug: file it, don't launder it.
- **Snapshot updates are reviewed diffs**, not a reflex — read what changed
  before accepting it.

A red test is evidence. If the test itself is wrong, fixing the test _is_
the change — say so explicitly, with the reason, in the commit and PR.
