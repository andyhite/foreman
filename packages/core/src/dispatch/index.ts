/*
 * Only the interface stays in core. `apply/cleanup.ts` takes a type-only
 * `Dispatcher`, and that is the whole of core's need — the `herdr` and `print`
 * implementations have no plugin or CLI consumer and live in `@foreman/loop`
 * (SPEC §3.1.1).
 */
export * from "./types.ts";
