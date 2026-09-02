/**
 * Wires `ControlHandlers` (contract §K, `@foreman/core/control/server.ts`)
 * to a live `Supervisor`. Kept separate from `Supervisor` itself so the
 * class stays testable without a socket, and separate from `main.ts` so the
 * op-by-op error shaping — "print dispatcher has no pane to attach", "herdr
 * kill unsupported" — lives in one reviewable place instead of scattered
 * across the request handler.
 *
 * `patchConfig` deep-merges onto `~/.foreman/config.json` and validates
 * before writing, the same rule `packages/cli/src/global-config.ts` follows
 * for its own narrower `ConfigPatch` — reimplemented here, generically over
 * the whole config, rather than imported: `packages/loop` must not depend
 * on `@foreman/cli`, and that helper's `ConfigPatch` only covers `repos`/
 * `linear.apiKeyFile`, not the loop settings a TUI's config editor needs to
 * patch (SPEC §17.9's config view).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultAndValidateGlobalConfig,
  isLoopMode,
  loadGlobalConfig,
  type ControlHandlers,
  type LoopMode,
} from "@foreman/core";
import type { Supervisor } from "./supervisor.ts";

export interface ControlHandlersOptions {
  supervisor: Supervisor;
  home?: string;
  /** Called after a successful `patchConfig`/`reload`, once the new `GlobalConfig` has been loaded from disk. */
  onConfigReloaded?: () => void;
}

/** Deep-merges `patch` onto `existing`, recursing into plain objects, patch wins on conflicts and arrays. */
function deepMerge(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    const current = existing[key];
    const bothPlainObjects =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current);
    merged[key] = bothPlainObjects
      ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return merged;
}

/**
 * Only the settings a TUI's config editor legitimately edits. `linear.*`
 * (endpoint, credential source) and `agent.ompBin`/`herdrBin` are excluded
 * deliberately: a dispatched agent reaches this socket as the same OS user,
 * and either key turns a live-config edit into credential exfiltration or
 * arbitrary-binary substitution at the next process start.
 */
const PATCHABLE_TOP_LEVEL_KEYS = new Set(["loop", "intake"]);

/**
 * Validates `patch` deep-merged onto the config already on disk, then
 * writes it — a typo must fail before it reaches disk, exactly like
 * `writeGlobalConfig` (SPEC §3.10).
 */
export function patchAndWriteGlobalConfig(patch: unknown, home: string): void {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patchConfig requires a JSON object");
  }
  const rejected = Object.keys(patch).filter((key) => !PATCHABLE_TOP_LEVEL_KEYS.has(key));
  if (rejected.length > 0) {
    throw new Error(`patchConfig may only patch ${[...PATCHABLE_TOP_LEVEL_KEYS].join(", ")}; refused: ${rejected.join(", ")}`);
  }
  const dir = join(home, ".foreman");
  const configPath = join(dir, "config.json");
  const existing = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};
  const merged = deepMerge(existing, patch as Record<string, unknown>);

  // Throws before anything touches disk if the merged patch is invalid.
  defaultAndValidateGlobalConfig(structuredClone(merged), configPath);

  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

export function createControlHandlers(options: ControlHandlersOptions): ControlHandlers {
  const { supervisor, home = homedir() } = options;

  return {
    snapshot: () => supervisor.snapshot(),

    pause: () => supervisor.pause(),

    resume: () => supervisor.resume(),

    stop: (mode) => supervisor.requestStop(mode),

    tick: (workers) => supervisor.requestTick(workers),

    setMode: (mode: LoopMode) => {
      if (!isLoopMode(mode)) throw new Error(`invalid loop mode: ${String(mode)}`);
      supervisor.setMode(mode);
    },

    patchConfig: (patch) => {
      patchAndWriteGlobalConfig(patch, home);
      const { config } = loadGlobalConfig({ home });
      if (!isLoopMode(config.loop.mode)) throw new Error(`invalid loop mode: ${String(config.loop.mode)}`);
      supervisor.reloadConfig(config);
      options.onConfigReloaded?.();
    },

    reload: () => {
      const { config } = loadGlobalConfig({ home });
      supervisor.reloadConfig(config);
      options.onConfigReloaded?.();
    },

    attachAgent: async (dispatchId: string) => {
      const handle = supervisor.handleFor(dispatchId);
      if (!handle) throw new Error(`no dispatch handle for ${dispatchId} (not in flight, or this loop restarted since it was dispatched)`);
      const { dispatcher } = supervisor;
      if (!dispatcher.attach) throw new Error("print dispatcher has no pane to attach");
      await dispatcher.attach(handle);
    },

    killAgent: async (dispatchId: string) => {
      const handle = supervisor.handleFor(dispatchId);
      const { dispatcher } = supervisor;
      if (!handle) throw new Error(`no dispatch handle for ${dispatchId} (not in flight, or this loop restarted since it was dispatched)`);
      if (dispatcher.kind === "herdr") {
        throw new Error(
          `herdr dispatches are not killable from here — run \`herdr agent kill ${handle.herdr?.agentName ?? dispatchId}\` directly`,
        );
      }
      if (handle.pid === null) throw new Error(`print dispatch ${dispatchId} has no process id to kill`);
      process.kill(handle.pid, "SIGTERM");
      // One print dispatch is one process for the whole batch (SPEC §17.4):
      // killing its pid ends every item in the batch, so every dispatch
      // record in the batch is cleared here, not just the one requested.
      for (const batched of supervisor.handlesInBatch(dispatchId)) {
        supervisor.bookkeeping.clearDispatch(batched.dispatchId);
        supervisor.forgetHandle(batched.dispatchId);
      }
      supervisor.bookkeeping.save();
    },
  };
}
