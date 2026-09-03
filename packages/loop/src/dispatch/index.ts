/*
 * The `herdr` and `print` dispatcher implementations have no plugin or CLI
 * consumer and live here, in `@foreman/loop` (SPEC §3.1.1). The `Dispatcher`
 * interface itself stays in `@foreman/core`.
 */
export * from "./herdr.ts";
export * from "./print.ts";
