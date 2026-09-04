/**
 * Loop dispatch preflight: refuses to start a loop whose Linear credential
 * cannot survive the env scrub applied to every dispatched agent (see
 * `assertLoopDispatchCredential`).
 */

import { assertLoopDispatchCredential, ConfigError, style, type GlobalConfig } from "@foreman/core";

/** Prints a ConfigError the way the three loop CLIs already do and reports whether the caller may proceed. */
export function preflightLoopConfig(config: GlobalConfig, prefix: string, home?: string): boolean {
  try {
    assertLoopDispatchCredential(config, home);
    return true;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(style("red", `[${prefix}] ${error.message}`));
    for (const problem of error.problems) console.error(style("red", `[${prefix}]   - ${problem}`));
    return false;
  }
}
