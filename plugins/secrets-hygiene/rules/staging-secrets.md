---
description: A bulk `git add` stages whatever is untracked, including secrets you did not create — read `git status` and name your paths instead
condition: '\bgit\s+add\s+(?:(?:-\S*|--)\s+)*(?:-A\b|--all\b|\.(?=\s|$)|\S*\.env(?=[\s.]|$)|\S*\.(?:pem|key|p12|keystore)(?=\s|$)|\S*id_(?:rsa|ed25519)(?=\s|$)|\S*credentials\.json(?=\s|$)|\S*service-account\S*\.json(?=\s|$))'
scope: "tool:bash"
interruptMode: tool-only
---

This `add` either names a credential-shaped path or stages the whole tree.
A pattern cannot inspect your working tree, so the discipline is yours:

- **Read `git status` before any bulk add** — not run it, read it. `-A`,
  `.`, and `--all` sweep in untracked files you never created: a local
  `.env`, a key you downloaded to debug, a tool's cached credential, a
  dump file with production rows in it.
- **Name the paths you mean.** `git add src/foo.ts src/foo.test.ts` cannot
  stage a secret by accident. `git add -A` can. That is the whole
  difference, and it costs one extra second.
- **Verify the ignore rule covers it; do not assume.**
  `git check-ignore -v <path>` prints the matching pattern and its source
  file. Silence means the file is unprotected — and an already-tracked file
  keeps being staged no matter what the ignore file says.
- **Staged but not committed is free to undo**: `git restore --staged
  <path>`. Read `git diff --cached --stat` before you commit.

Once it is committed and pushed the file is out, and later deletion leaves
it in history. At that point the credential must be rotated — rotate first,
clean history after, never the reverse.
