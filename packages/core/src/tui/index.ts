/**
 * The terminal toolkit `foreman tui` renders with.
 *
 * Hand-rolled for the same reason the argument parsers and prompts are: the
 * workspace's sole runtime dependency is `@sinclair/typebox`, and a
 * full-screen dashboard is not worth a React reconciler and fifty transitive
 * packages. The split below is the one that matters — `canvas`/`layout`/
 * `width` are pure geometry over a cell grid, `widgets` are pure functions
 * from a rect to marks on that grid, and only `screen`/`app` are allowed to
 * touch the terminal. That is what makes a view testable without a TTY.
 *
 * `packages/core/src/render/status.ts` renders into an omp chat session
 * instead and must never import any of this; it stays Markdown.
 */

export * from "./app.ts";
export * from "./clipboard.ts";
export * from "./canvas.ts";
export * from "./keys.ts";
export * from "./layout.ts";
export * from "./screen.ts";
export * from "./theme.ts";
export * from "./widgets/index.ts";
export * from "./width.ts";
