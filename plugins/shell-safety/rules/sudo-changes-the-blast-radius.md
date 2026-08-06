---
description: sudo steps outside the project into machine state — nothing there is version-controlled and nothing rolls back
condition: '(^|[^\w-])sudo\s+\S'
scope: "tool:bash"
interruptMode: tool-only
---

`sudo` changes what a mistake costs. The working tree is recoverable;
the machine is not:

- **Version control ends at the repo boundary.** Nothing tracks a
  system package, a file installed outside the project, or a path whose
  owner just became root. No diff, no revert.
- **Nearly every in-repo need has a non-sudo path.** Dependencies
  install into the project via its own package manager; files in the
  working tree are already writable; ports above 1024 bind unprivileged.
- **`sudo pip install` and `sudo npm install -g` corrupt an OS-managed
  environment** — they write into an interpreter the system owns and
  upgrades, so a routine update breaks the project.
- **A root-owned file inside the repo is a defect you leave behind** —
  the next unprivileged step cannot write it without another `sudo`.
- **If root is genuinely required, say what and why first** — which
  path, which service, which port — then run the smallest command that
  does that one thing.

A permission error is usually a wrong-directory or wrong-environment
signal, not a request for privileges.
