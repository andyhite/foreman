# secrets-hygiene

Four tool-call interrupt rules for the two ways a credential escapes: into
the repository, and into the transcript. Nothing here knows about issue
trackers, boards, or any particular workflow — install it in any repo.

| Rule | Fires on | Point |
|---|---|---|
| `secret-files-stay-untracked` | writing `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `*.p12`, `*.keystore`, `credentials.json`, `service-account*.json` | A tracked secret is compromised on push and survives its own deletion. Rotate the credential; a follow-up commit is not a fix. |
| `staging-secrets` | `git add .env`, `git add *.pem`, and the bulk forms `-A` / `.` / `--all` | A pattern can't see your working tree. Read `git status`, name the paths you mean, and verify the ignore rule instead of assuming it. |
| `no-secrets-in-transcripts` | bare `env`/`printenv`, `cat` of a `.env` or key file, `echo $*TOKEN*`/`*SECRET*`/`*KEY*`/`*PASSWORD*`/`*CREDENTIAL*` | A printed secret is in the log, the export, and the telemetry. To check a variable is set, test that it's non-empty or print its length. |
| `hardcoded-credentials` | `--password`/`--token`/`--api-key` with a literal value, `PGPASSWORD=`/`MYSQL_PWD=` prefixes | Shell history and `ps` output are not private. Use an environment variable, a credential helper, or stdin. |

The three command rules are scoped `tool:bash` with
`interruptMode: tool-only`, so they fire on actual shell execution — never
on a `write`/`edit` that merely *mentions* one of these commands in prose or
a code block. `secret-files-stay-untracked` is the inverse: it is a path
rule, matched against the file a `write`/`edit` targets.

Note that `**/.env.*` deliberately matches `.env.example` and
`.env.template`, which *are* meant to be committed. The rule says so, and
says what makes them safe: keys with empty or obviously-placeholder values,
never real ones.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install secrets-hygiene@omp-foreman
```

Independent of the other plugins in this marketplace — install any of them,
all of them, or just this one.
