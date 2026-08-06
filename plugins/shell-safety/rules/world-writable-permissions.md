---
description: World-writable permissions are a debugging shortcut that gets committed — every local process can rewrite the file, and some tooling refuses the mode outright
condition: '(^|[^\w-])chmod\s+(?:-[a-zA-Z-]+\s+)*(?:[0-7]?[0-7][0-7][2367]\b|(?:[ugo]*a[ugo]*|o)\+[rwx]*w|\+rwx\b)'
scope: "tool:bash"
interruptMode: tool-only
---

`777`, `666`, and `a+rwx` are what a permission error gets you past in
ten seconds — and then they get committed and shipped:

- **World-writable means any local account or process can rewrite the
  file**, including anything that gets execution as another user. In a
  committed script or an image layer it is a review finding.
- **It usually isn't the actual problem.** The cause is ownership, or a
  parent directory's mode. Run `ls -ld` on the path *and* its parent,
  then fix ownership with `chown`.
- **Some tooling refuses an over-permissive mode outright** — ssh
  ignores a private key that is group- or world-readable and fails the
  connection. That mode is a defect, not a warning to route around.
- **The modes that work:** `755` for executables and directories, `644`
  for regular files, `600` for keys and credentials.
- **`-R` multiplies all of it**, hitting every file below the path —
  dotfiles, credentials, the repository's own metadata directory.

If a container or a shared volume genuinely needs a loose mode, it
belongs in the image or service definition with a comment, not in a
loose `chmod` from a shell session.
