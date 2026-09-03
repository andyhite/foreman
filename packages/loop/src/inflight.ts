/**
 * `<stateDir>/<alias>/<loop>.json` — in-flight dispatch and failure
 * bookkeeping for `foreman plan`/`foreman build` (simplification plan Phase
 * 4). Explicitly **non-authoritative**, the same way the deleted
 * `bookkeeping.ts` was: losing this file costs at most one redundant
 * dispatch (a stale in-flight record outliving the real spawn) or one
 * premature retry (a failure counter reset to zero). The write path is
 * temp-file-then-rename within the same directory, so a concurrent reader
 * sees either the previous complete file or the new one, never a
 * half-written one.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Dispatcher, DispatchHandle } from "@foreman/core";

export interface InflightEntry {
  handle: DispatchHandle;
  startedAt: string;
}

interface InflightFile {
  inFlight: Record<string, InflightEntry>;
  failures: Record<string, number>;
}

function emptyFile(): InflightFile {
  return { inFlight: {}, failures: {} };
}

/**
 * Tracks which `Rule` candidates are currently dispatched and how many times
 * each has failed, across process restarts. `load` drops any `inFlight`
 * entry whose dispatcher reports a terminal status (`"lost"` or `"settled"`)
 * — a crash between writing the record and the dispatch actually settling,
 * or a restart after settling raced the final `remove()`, must not wedge
 * that key forever.
 */
export class InflightStore {
  readonly #path: string;
  #state: InflightFile;

  private constructor(path: string, state: InflightFile) {
    this.#path = path;
    this.#state = state;
  }

  static async load(path: string, dispatcher: Dispatcher): Promise<InflightStore> {
    let state = emptyFile();
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as Partial<InflightFile>;
        state = { ...emptyFile(), ...parsed };
      } catch {
        state = emptyFile();
      }
    }

    for (const [key, entry] of Object.entries(state.inFlight)) {
      const status = await dispatcher.status(entry.handle);
      if (status === "lost" || status === "settled") delete state.inFlight[key];
    }

    const store = new InflightStore(path, state);
    store.#save();
    return store;
  }

  has(key: string): boolean {
    return key in this.#state.inFlight;
  }

  inFlightCount(): number {
    return Object.keys(this.#state.inFlight).length;
  }

  failures(key: string): number {
    return this.#state.failures[key] ?? 0;
  }

  record(key: string, handle: DispatchHandle): void {
    this.#state.inFlight[key] = { handle, startedAt: new Date().toISOString() };
    this.#save();
  }

  remove(key: string): void {
    delete this.#state.inFlight[key];
    this.#save();
  }

  recordFailure(key: string): void {
    this.#state.failures[key] = (this.#state.failures[key] ?? 0) + 1;
    this.#save();
  }

  clearFailures(key: string): void {
    delete this.#state.failures[key];
    this.#save();
  }

  #save(): void {
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true });
    const tempPath = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.#state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.#path);
    chmodSync(this.#path, 0o600);
  }
}
