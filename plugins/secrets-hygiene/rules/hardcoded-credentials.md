---
description: A credential passed as a literal argument lands in shell history and in process listings other local users can read — pass it by environment variable, credential helper, or stdin
condition: '--(?:password|passwd|token|api[-_]?key)(?:=|\s+)(?!["'']?\$)\S|\b(?:PGPASSWORD|MYSQL_PWD)='
scope: "tool:bash"
interruptMode: tool-only
---

That command carries a credential as a literal value. Two leaks, neither
under your control once the line runs: **shell history**, which records the
command verbatim in plaintext and syncs with the home directory, and
**process listings**, where full argv is readable by every other local user
for as long as the process lives (`ps aux`). The safe form, by case:

- **Environment variable** — `--password "$DB_PASSWORD"` keeps the value out
  of argv entirely. Set the variable from a file the shell sources, not from
  a typed assignment that history records.
- **Credential helper** — most CLIs have one: a config file at `0600`, an OS
  keychain entry, or the tool's own login subcommand. That is the intended
  path; the flag is the fallback.
- **stdin** — `--password-stdin`, `--token-file`, or `-` as the value where
  supported. stdin is neither argv nor history.
- **`PGPASSWORD=` / `MYSQL_PWD=`** also leak into every child process's
  environment. Prefer a `~/.pgpass` or `~/.my.cnf` entry at `0600`, which
  the client reads with no secret on the command line at all.

A credential already typed literally on a shared or logged machine is one to
rotate, not one to be more careful with next time.
