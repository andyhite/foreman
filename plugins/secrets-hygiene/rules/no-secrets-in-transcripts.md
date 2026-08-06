---
description: Printing an environment or a credential file puts the secret in the conversation log — check that a variable is set without revealing its value
condition: '(?:^|[;&|]\s*|\$\(\s*)(?:env|printenv)\s*(?:$|[;&|])|\bcat\s+(?:\S*\.env\b|\S*\.(?:pem|key|p12|keystore)(?=\s|$)|\S*id_(?:rsa|ed25519)(?=\s|$))|\becho\s+"?\$\{?\w*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)'
scope: "tool:bash"
interruptMode: tool-only
---

That command dumps an environment or a credential file to stdout, and the
output does not stay in your terminal — it is in the conversation log, in
any exported transcript, and in whatever CI log, crash report, or telemetry
captured the run. Treat anything printed as disclosed, and rotate it.

- **Bare `env` / `printenv` prints everything**, including tokens injected
  by a shell profile or CI runner that you never intended to look at.
- **`cat` of a `.env` or a private key** puts the literal material in the
  log. A private key that appears in a transcript is a key to replace.
- **`echo $SOMETHING_TOKEN`** is the same disclosure, one line long.

The real intent is almost always "is this variable set?" — answer that
without revealing the value:

- `[ -n "$API_TOKEN" ] && echo set || echo unset` — presence only.
- `echo "${#API_TOKEN}"` — the length proves it is populated and non-empty.
- `printenv | cut -d= -f1 | sort` — variable names, no values.

If a command genuinely needs the value, pass it through as `"$VAR"` so it
flows to the consumer without ever passing through the transcript.
