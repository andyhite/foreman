/**
 * Core's single door to TypeBox.
 *
 * Every schema in this package imports `Type`/`Value` from here, and nothing
 * else in the workspace imports `@sinclair/typebox*` directly. The reason is
 * the subpath specifiers below, which look like a pointless detour and are
 * not:
 *
 * omp rewrites the *bare* specifier `@sinclair/typebox` to its own bundled
 * `@oh-my-pi/omptype` facade when it loads an extension. That facade wears a
 * TypeBox-shaped API over a different validator, and the substitution is
 * lossy in two ways that break this package (both verified against omp
 * 18.1.4 by loading a probe extension over ACP):
 *
 *   - `Type.Object(...)` returns an opaque validator *function* carrying its
 *     own IR (`ir`, `run`, `safeParse`), not a JSON Schema object. It has no
 *     `.properties`, and `JSON.stringify` throws on it. Core's schemas are
 *     emitted as the `schemas/*.json` agent output contracts and diffed by
 *     `check-contract.ts`, so the JSON Schema shape is the product, not an
 *     implementation detail.
 *   - It rejects a mutable `default` outright: `default: {}` fails to parse
 *     with "A mutable default value must be specified as a factory". The
 *     eleven object-level `default: {}` entries in `config/schema.ts` are how
 *     `Value.Default` materialises absent config blocks.
 *
 * The rewrite matches the bare specifier only, so `@sinclair/typebox/type`
 * and `@sinclair/typebox/value` reach real TypeBox in every host. That
 * matters beyond the extension: `packages/cli` ships the standalone `foreman`
 * binary and `packages/loop` runs the supervisor, neither of which has omp in
 * scope at all - `foreman init` is what installs the omp plugin, so it
 * necessarily runs before omp's runtime exists in a repo. Core has to hold
 * one schema implementation that is correct with or without omp present, and
 * real TypeBox is the only candidate.
 *
 * Importing the bare specifier anywhere in core would compile, pass tests
 * under `bun test`, and then silently degrade to the facade inside a live omp
 * session - a failure mode that surfaces only as a missing extension in omp's
 * debug log. `test/typebox-import.test.ts` fails the build instead.
 */

export { type Static, type TSchema, type TUnion, Type } from "@sinclair/typebox/type";
export { Value } from "@sinclair/typebox/value";
