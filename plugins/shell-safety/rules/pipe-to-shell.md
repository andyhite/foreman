---
description: Piping a download straight into a shell executes an unreviewed remote payload with your privileges — and the server picks what to send
condition: '(^|[^\w-])(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+(?:-\w+\s+)*)?(?:sh|bash|zsh|dash|ksh|fish)\b'
scope: "tool:bash"
interruptMode: tool-only
---

`curl … | sh` runs code nobody read, as you:

- **Nothing in the transcript says what executed** — only a URL. It
  runs with your user's rights over your dotfiles, credentials, and
  every repo on the disk; piped into `sudo bash`, with root's.
- **Reading the URL first is not evidence about the run.** The server
  can serve a different body to an inspecting fetch than to an
  executing one — it sees the user agent, whether output is a
  terminal, and how many times you asked.
- **A truncated download still executes.** The shell runs each complete
  line as it arrives, so a dropped connection leaves a half-applied
  install with no error to catch.
- **Download, read, then run.** `curl -fsSL <url> -o install.sh`, read
  it, then `sh ./install.sh`. Pin a tag or commit URL rather than
  `latest`, and check a published checksum.
- **Better, install through the platform's package manager** — pinned
  version, verified payload, recorded file list, real uninstall.

This is not about whether the vendor is trustworthy. The pipe deletes
the only step where a bad or truncated payload gets caught.
