import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GlobalConfigSchema } from "../src/config/schema.ts";

/*
 * `src/typebox.ts` explains the stakes in full: omp rewrites the bare
 * `@sinclair/typebox` specifier to its own facade when it loads an extension,
 * and the substitution both rejects `default: {}` and returns validators with
 * no `.properties`. A bare import compiles, passes every other test, and then
 * degrades only inside a live omp session, where the sole symptom is a line in
 * omp's debug log. So the invariant is worth a test rather than a comment: one
 * file reaches TypeBox, everything else goes through it.
 */

const WORKSPACE = join(import.meta.dir, "..", "..", "..");
const CHOKEPOINT = join(WORKSPACE, "packages", "core", "src", "typebox.ts");

function sourceFiles(): string[] {
  const glob = new Bun.Glob("packages/*/src/**/*.ts");
  return [...glob.scanSync({ cwd: WORKSPACE, absolute: true })];
}

describe("typebox imports", () => {
  it("routes every package through core's chokepoint", () => {
    const files = sourceFiles();
    // A glob that silently matches nothing would make this test vacuous.
    expect(files.length).toBeGreaterThan(20);

    const offenders = files
      .filter((file) => file !== CHOKEPOINT)
      .filter((file) => /from\s+"(?:@sinclair\/typebox[^"]*|typebox)"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(WORKSPACE, file));

    expect(offenders).toEqual([]);
  });

  it("reaches real TypeBox by subpath, never the rewritten bare specifier", () => {
    const source = readFileSync(CHOKEPOINT, "utf8");
    expect(source).toContain('from "@sinclair/typebox/type"');
    expect(source).toContain('from "@sinclair/typebox/value"');
    expect(source).not.toMatch(/from\s+"@sinclair\/typebox"/);
  });

  it("keeps the JSON Schema shape omp's facade would destroy", () => {
    // The two properties that made the facade unusable: an object-level
    // `default: {}` survives, and the schema is a plain JSON Schema object.
    expect(GlobalConfigSchema.default).toEqual({});
    expect(GlobalConfigSchema.properties).toBeDefined();
    expect(() => JSON.stringify(GlobalConfigSchema)).not.toThrow();
  });
});
