/**
 * Barrel for the TUI widget layer. Every widget module is a pure function
 * over `(canvas, rect, options)` — no terminal IO, no module-level state —
 * so views can import the set without caring which file backs which name.
 */

export * from "./panel.ts";
export * from "./table.ts";
export * from "./gauge.ts";
export * from "./badge.ts";
export * from "./keyhints.ts";
export * from "./kv.ts";
export * from "./logview.ts";
export * from "./modal.ts";
export * from "./tabs.ts";
export * from "./spinner.ts";
export * from "./field.ts";
