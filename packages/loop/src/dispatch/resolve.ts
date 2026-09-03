/**
 * Dispatcher selection for `foreman plan`/`foreman build`
 * (simplification plan Phase 4). `config.agent.dispatcher: "auto"` prefers
 * herdr when its substrate is reachable, falling back to print — the same
 * degrade-rather-than-stall rule `dispatch/types.ts` documents for the
 * dispatchers themselves.
 */

import type { Dispatcher, GlobalConfig } from "@foreman/core";
import { HerdrDispatcher } from "./herdr.ts";
import { PrintDispatcher } from "./print.ts";

export async function resolveDispatcher(config: GlobalConfig): Promise<Dispatcher> {
  if (config.agent.dispatcher === "print") return new PrintDispatcher(config);
  if (config.agent.dispatcher === "herdr") return new HerdrDispatcher(config);

  const herdr = new HerdrDispatcher(config);
  if (await herdr.available()) return herdr;
  return new PrintDispatcher(config);
}
