/**
 * Dispatcher selection for `foreman plan`/`foreman build`
 * (simplification plan Phase 4). `config.agent.dispatcher: "auto"` prefers
 * herdr when its substrate is reachable, falling back to print — the same
 * degrade-rather-than-stall rule `dispatch/types.ts` documents for the
 * dispatchers themselves.
 */

import { linearEnvNames } from "@foreman/core";
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
} from "@foreman/core";
import { HerdrDispatcher, isHerdrUnavailable } from "./herdr.ts";
import { PrintDispatcher } from "./print.ts";

/** SPEC §17.2: a herdr that stops answering degrades to print rather than stalling the loop. Exported for direct testing of `#ownerOf`'s restart-time routing (step 5.2). */
export class FallbackDispatcher implements Dispatcher {
  readonly kind: "print" | "herdr";

  readonly #primary: Dispatcher;
  readonly #fallback: Dispatcher;
  readonly #owner = new Map<string, Dispatcher>();

  constructor(primary: Dispatcher, fallback: Dispatcher) {
    this.#primary = primary;
    this.#fallback = fallback;
    this.kind = primary.kind;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    try {
      const handles = await this.#primary.dispatch(request);
      for (const handle of handles) this.#owner.set(handle.dispatchId, this.#primary);
      return handles;
    } catch (error) {
      if (!isHerdrUnavailable(error)) throw error;
      const handles = await this.#fallback.dispatch(request);
      for (const handle of handles) this.#owner.set(handle.dispatchId, this.#fallback);
      return handles;
    }
  }

  #ownerOf(handle: DispatchHandle): Dispatcher {
    // After a restart `#owner` is empty for every persisted handle. A
    // herdr handle carries a non-null `herdr` field (SPEC §17.2); routing
    // it to the print fallback would let `status`/`settle` answer
    // "settled" for a handle they know nothing about, defeating
    // `InflightStore`'s persistence of still-running herdr dispatches.
    return this.#owner.get(handle.dispatchId) ?? (handle.herdr ? this.#primary : this.#fallback);
  }

  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    return this.#ownerOf(handle).status(handle);
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    return this.#ownerOf(handle).settle(handle);
  }

  async cleanup(issueId: string, repoPath: string, worktreePath: string | null): Promise<void> {
    await this.#primary.cleanup?.(issueId, repoPath, worktreePath);
  }

  async available(): Promise<boolean> {
    return (await this.#primary.available()) || this.#fallback.available();
  }
}

export async function resolveDispatcher(config: GlobalConfig): Promise<Dispatcher> {
  if (config.agent.dispatcher === "print") return new PrintDispatcher(config, { scrubEnv: linearEnvNames(config) });
  if (config.agent.dispatcher === "herdr") return new HerdrDispatcher(config, { scrubEnv: linearEnvNames(config) });

  const herdr = new HerdrDispatcher(config, { scrubEnv: linearEnvNames(config) });
  const print = new PrintDispatcher(config, { scrubEnv: linearEnvNames(config) });
  if (await herdr.available()) return new FallbackDispatcher(herdr, print);
  return print;
}
