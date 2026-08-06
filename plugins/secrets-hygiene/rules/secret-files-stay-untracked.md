---
description: These filenames are the shape of a credential store — a real secret in a tracked file is compromised on push and survives its own deletion
condition:
  - "**/.env"
  - "**/.env.*"
  - "**/*.pem"
  - "**/*.key"
  - "**/id_rsa"
  - "**/id_ed25519"
  - "**/*.p12"
  - "**/*.keystore"
  - "**/credentials.json"
  - "**/service-account*.json"
interruptMode: tool-only
---

You are writing a file named like a credential store. Two cases:

- **`.env.example` and `.env.template` are meant to be committed.** The
  `**/.env.*` glob above matches them, so this rule fires on them too — that
  is expected: they document *which* keys the app reads, with empty or
  obviously-placeholder values, never working ones. Pasting a real value in
  to look realistic is the most common way a live key gets committed.
- **Everything else here stays untracked**: `.env` and its real variants,
  private keys (`*.pem`, `*.key`, `id_rsa`, `id_ed25519`), keystores
  (`*.p12`, `*.keystore`), and cloud service credentials
  (`credentials.json`, `service-account*.json`) — ignore file, not index.
- **Confirm the ignore rule before you write.** `git check-ignore -v <path>`
  prints the matching pattern and its source; a non-zero exit means nothing
  protects that path, and a personal global ignore protects no other clone.
- **A `*.key` holding no secret** — public key, fixture, license file — is
  fine to track; prefer a name that does not read as a private key.

A secret in a tracked file is compromised the moment it is pushed, and
deleting it later does not remove it — every clone and fork still has it.
The remedy is **rotating the credential**, not a follow-up commit.
