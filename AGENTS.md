# Foreman

Foreman dispatches work to peer coding agents that each own a git worktree and
a branch, then carries their reports and questions back. It is a single
omp-native agent plugin: one extension (`extension/index.ts`) exposing five
tools — `foreman_spawn`, `foreman_send`, `foreman_ask`, `foreman_ls`,
`foreman_reap` — identical in every session. No roles, no claiming step, no
bash CLI, no MCP sidecar, no slash commands. State lives under
`$FOREMAN_STATE` (default `~/.foreman/<slug>/`), keyed by handle; nothing is
written into a repo a worker operates on.

The design rationale lives in `docs/ARCHITECTURE.md`.

## Verify

```sh
bunx tsc --noEmit
bun test
```

CI runs exactly this, plus a check that `.omp-plugin/plugin.json` and
`package.json` carry the same `version`.

## Delivery rules

- **Never use `pi.sendMessage`.** It was measured to silently drop
  `{ deliverAs: "followUp", triggerTurn: true }` — the tool call resolves
  without error and the message never arrives. Every delivery in this repo
  goes through `pi.sendUserMessage`, a real user turn. `deliveryOptions` in
  `extension/index.ts` is the one function that encodes which delivery shape
  is used per message kind — change it there, not at each call site.
- **Always arm timers with `ctx.setInterval`, never bare `setInterval`.** A
  throw from a bare timer reaches `uncaughtException` and kills the whole
  session; `ctx.setInterval` contains throws and auto-clears on session
  shutdown.
- The drain loop's re-entrancy guard (`draining`, in `drainOnce`) exists
  because a `sendUserMessage` slower than the poll interval would otherwise
  double-deliver — do not remove it to "simplify" the loop.

## House conventions

- Comments justify decisions: each one names the bug it prevents or the
  alternative it rejects, not what the line does. Match this in every edit.
- Skills are referenced as `skill://<name>` everywhere, never `foreman
  skill ...` — there is no CLI left to invoke that way.
- One version string, two files: `.omp-plugin/plugin.json` and
  `package.json` must agree (CI enforces).
- `extension/pi-coding-agent.d.ts` declares only the slice of
  `@oh-my-pi/pi-coding-agent` and Node built-ins that `extension/index.ts`
  actually calls — extend it if that file starts touching more of the real
  API, don't pad it ahead of need.
- Handles (`[a-z][a-z0-9_-]{0,31}`) are the only worker identifiers, derived
  from the worktree's directory name with no claiming step — the first
  session to run from a given `repoRoot` registers it permanently.
