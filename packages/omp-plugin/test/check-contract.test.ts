import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// `readFrontmatter` is a private helper in scripts/check-contract.ts, so the
// only way to exercise its `sequences` handling (C4) is to run the script
// itself against a mutated copy of the plugin tree — the same technique the
// script's own header comment names as how its failure paths get tested.
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginRoot, "scripts", "check-contract.ts");

describe("check-contract — readFrontmatter detects a block-sequence `spawns:`", () => {
  it("fails the contract check with a problem naming `spawns` when an agent declares it as a YAML sequence", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "foreman-contract-"));
    try {
      cpSync(pluginRoot, tmpRoot, { recursive: true });
      const agentPath = join(tmpRoot, "agents", "foreman-implement.md");
      const original = readFileSync(agentPath, "utf8");
      // Insert a block-sequence `spawns:` into the frontmatter — the shape
      // `readFrontmatter` routes into `sequences`, not `scalars`, which is
      // exactly what let this bypass the old `scalars.has("spawns")` check.
      const mutated = original.replace(
        "name: foreman-implement\n",
        "name: foreman-implement\nspawns:\n  - foreman-implement\n",
      );
      expect(mutated).not.toBe(original);
      writeFileSync(agentPath, mutated);

      const result = spawnSync("bun", ["run", scriptPath, tmpRoot], { encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("sets `spawns`");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
