/**
 * `@foreman/core` — the one place the Linear client, the output schemas, and the
 * gate validators exist.
 *
 * Foreman is two consumers over this core (SPEC §3.1): the omp plugin
 * extension and the loop supervisor. Duplicating a validator between them is
 * how the workers and the agents start disagreeing about whether an issue is
 * ready, so nothing here is re-implemented downstream.
 */

export * from "./apply/index.ts";
export * from "./config/index.ts";
export * from "./control/index.ts";
export * from "./dispatch/index.ts";
export * from "./domain/labels.ts";
export * from "./domain/priority.ts";
export * from "./domain/states.ts";
export * from "./ensure.ts";
export * from "./gates/index.ts";
export * from "./git/index.ts";
export * from "./github/index.ts";
export * from "./linear/index.ts";
export * from "./lock.ts";
export * from "./markers.ts";
export * from "./render/index.ts";
export * from "./repo.ts";
export * from "./schemas/index.ts";
export * from "./schemas/parse.ts";
export * from "./team.ts";
export * from "./tui/index.ts";
