# Foreman

Foreman dispatches work to peer coding agents that each own a git worktree and
a branch, then carries their reports and questions back. It is a single
omp-native agent plugin: one extension (`extension/index.ts`) exposing six
tools — `foreman_spawn`, `foreman_send`, `foreman_ask`, `foreman_wait`,
`foreman_ls`, `foreman_reap` — identical in every session. No roles, no
claiming step, no bash CLI, no MCP sidecar, no slash commands. State lives
under `$FOREMAN_STATE` (default `~/.foreman/<slug>/`), keyed by handle;
nothing is written into a repo a worker operates on.

The design rationale lives in `docs/ARCHITECTURE.md`.

## Verify

```sh
bunx tsc --noEmit
bun test
```

CI runs exactly this, plus a check that `.omp-plugin/plugin.json` and
`package.json` carry the same `version`. On every push to `main`, CI also
tags the commit `vX.Y.Z` from `package.json#version` if that tag doesn't
already exist yet — bumping the version is the entire release trigger, no
manual `git tag` step. `omp install`/`omp plugin install` git specs and the
marketplace `"./"` source both float to `main` HEAD unless a caller pins
`#vX.Y.Z`, so an untagged bump is installable immediately and a tagged one
stays reproducible.

## Delivery rules

- **Every delivery goes through `pi.sendMessage`, always with
  `triggerTurn: true`.** `triggerTurn` is the load-bearing flag, not
  `deliverAs`: without it a queued message waits for a next *user* prompt,
  which never comes in a worker pane, and is silently lost. `sendUserMessage`
  is not an option — it takes no `triggerTurn`, which is why it could not
  reach an idle receiver. `deliveryOptions` in `extension/index.ts` is the one
  function that encodes which delivery shape each message kind gets — change
  it there, not at each call site.
- **Always arm timers with `ctx.setInterval`, never bare `setInterval`.** A
  throw from a bare timer reaches `uncaughtException` and kills the whole
  session; `ctx.setInterval` contains throws and auto-clears on session
  shutdown.
- **Mail must reach exactly one delivery path.** A blocked `foreman_wait` or
  `foreman_ask` parks a resolver in `waiter`, and `drainOnce` hands the batch
  to it *instead of* calling `pi.sendMessage` — that caller has already
  stopped and is about to read the same messages as its tool result, so
  injecting a turn too would deliver them twice. Whichever of mail, timeout,
  or abort arrives first must clear the slot, or the next batch resolves a
  promise nobody awaits and is never injected.
- The drain's re-entrancy guard (`draining`, in `drainOnce`) exists because a
  `sendMessage` slower than the next watcher event would otherwise
  double-deliver — do not remove it to "simplify" the loop. It also means a
  drain you call yourself can be a no-op while another is still in flight.

## House conventions

- Comments justify decisions: each one names the bug it prevents or the
  alternative it rejects, not what the line does. Match this in every edit.
- Skills are referenced as `skill://<name>` everywhere, never `foreman
  skill ...` — there is no CLI left to invoke that way.
- One version string, three files: `.omp-plugin/plugin.json` and
  `package.json` must agree (CI enforces), and the README's version badge
  must be bumped with them (CI does *not* catch that one).
- `extension/pi-coding-agent.d.ts` declares only the slice of
  `@oh-my-pi/pi-coding-agent` and Node built-ins that `extension/index.ts`
  actually calls — extend it if that file starts touching more of the real
  API, don't pad it ahead of need.
- Handles (`[a-z][a-z0-9_-]{0,31}`) are the only worker identifiers, derived
  from the worktree's directory name with no claiming step — the first
  session to run from a given `repoRoot` registers it permanently.
