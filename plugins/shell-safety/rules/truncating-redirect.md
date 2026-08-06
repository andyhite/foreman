---
description: A truncating redirect empties the target before the command runs — a command that fails leaves the source file blank
condition: '(^|[\s\d"''])>\s*(?![>=])[^\s>&|;()]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|sql|css|scss|less|html|vue|svelte|lua|dart|scala|ex|exs|hs|pl|gradle)\b'
scope: "tool:bash"
interruptMode: tool-only
---

That `>` writes over a source file, and it does so **before the command
on its left ever runs**:

- **The shell truncates first.** Redirection is set up while the
  process is still spawning, so a command that errors, exits early, or
  prints nothing has already emptied the target to zero bytes.
- **`>` onto a tracked file is a whole-file replacement, not an edit.**
  Everything the command did not reproduce — imports, the rest of the
  module, the parts unrelated to your change — is gone, with no diff.
- **`>>` appends.** If the intent is adding a line to the end of a
  file, that is the operator; it never truncates.
- **Real content changes belong in an editor or a patch** — an
  edit/write call or an applied patch shows the diff and keeps the rest
  of the file.
- **If a file genuinely is a command's output**, redirect to a temp path
  and move it into place, so a failed run leaves the previous version
  intact.

Redirecting data and logs is fine — this fires on source-shaped paths,
where the contents are the thing under version control.
