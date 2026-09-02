/*
 * Only the interface stays in core. `apply/cleanup.ts` takes a type-only
 * `Dispatcher`, and that is the whole of core's need — the `herdr` and `print`
 * implementations have no plugin or CLI consumer and live in `@foreman/loop`
 * (SPEC §3.1.1).
 *
 * The reservations file is the exception that has to live here: the loop
 * writes it and the plugin's task guard reads it, so it is exactly the "two
 * consumers need it" case `core` exists for (SPEC §17.4).
 */
export * from "./reservations.ts";
export * from "./types.ts";
