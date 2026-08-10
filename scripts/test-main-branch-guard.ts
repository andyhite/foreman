#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import foreman from "../src/index.js";
import {
  analyzeShellCommand,
  decideMainBranchGuard,
  discoverForemanConfig,
  splitShellFragments,
  type ForemanConfigDiscovery,
} from "../src/main-branch-guard.js";

const config: ForemanConfigDiscovery = {
  kind: "configured",
  path: "/repo/.omp/foreman.json",
  mainBranch: "main",
};

function decision(command: string, branch: string, discovered = config) {
  return decideMainBranchGuard({
    analysis: analyzeShellCommand(command, "/repo"),
    config: discovered,
    branch,
  });
}

assert.ok(decision('git commit -m "keep changes"', "main"));
assert.ok(decision("git push", "main"));
assert.equal(decision("git status", "main"), undefined);
assert.equal(decision("git diff --cached", "main"), undefined);
assert.equal(decision("git pull --ff-only origin main", "main"), undefined);

assert.equal(decision('git commit -m "topic work"', "feat/guard"), undefined);
assert.equal(decision("git push", "feat/guard"), undefined);
assert.ok(decision("git push origin main", "feat/guard"));
assert.ok(decision("git push origin HEAD:main", "feat/guard"));
assert.ok(decision("git push --delete origin main", "feat/guard"));

assert.ok(decision('git status && git commit -m "later fragment"', "main"));
assert.equal(decision('git commit -m "a; b | c && d"', "feat/guard"), undefined);
assert.deepEqual(splitShellFragments('git commit -m "a; b | c && d"').fragments, [
  'git commit -m "a; b | c && d"',
]);

assert.ok(decision('echo "$(git commit -m hidden)"', "feat/guard"));
assert.ok(decision("git branch -D stale-topic", "main"));
assert.ok(decision("git switch --discard-changes feat/new", "main"));
assert.ok(decision("git -C ../other commit -m x", "feat/guard"));
assert.equal(analyzeShellCommand("cd packages/api && git commit -m x", "/repo").cwd, "/repo/packages/api");
assert.ok(decision("cd $TARGET && git commit -m x", "feat/guard"));
assert.equal(decision("git checkout -b feat/new", "main"), undefined);
assert.ok(decision("git checkout -- src/index.ts", "main"));

const files: Record<string, string> = {
  "/repo/.omp/foreman.json": JSON.stringify({ mainBranch: "trunk" }),
};
const filesystem = {
  exists(path: string) {
    return Object.hasOwn(files, path);
  },
  read(path: string) {
    const content = files[path];
    if (content === undefined) throw new Error(`missing fixture: ${path}`);
    return content;
  },
};
assert.deepEqual(discoverForemanConfig("/repo/packages/api", filesystem), {
  kind: "configured",
  path: "/repo/.omp/foreman.json",
  mainBranch: "trunk",
});
assert.equal(decision("git commit -m x", "main", { kind: "missing" }), undefined);
assert.ok(
  decision("git commit -m x", "main", {
    kind: "invalid",
    path: "/repo/.omp/foreman.json",
  }),
);

const guardRoot = mkdtempSync(join(tmpdir(), "foreman-main-guard-"));
mkdirSync(join(guardRoot, ".omp"));
writeFileSync(
  join(guardRoot, ".omp", "foreman.json"),
  JSON.stringify({ mainBranch: "main" }),
);

type ToolCallHandler = (
  event: { toolName: string; input: { command: string } },
  ctx: { cwd: string },
) => Promise<{ block: true; reason: string } | undefined>;
let toolCall: ToolCallHandler | undefined;
let branchForHook = "main";
foreman({
  setLabel() {},
  on(event: string, handler: ToolCallHandler) {
    if (event === "tool_call") toolCall = handler;
  },
  async exec() {
    return { code: 0, stdout: `${branchForHook}\n` };
  },
} as never);

assert.ok(toolCall);
assert.ok(
  await toolCall(
    { toolName: "bash", input: { command: 'git commit -m "blocked"' } },
    { cwd: guardRoot },
  ),
);
branchForHook = "feat/guard";
assert.equal(
  await toolCall(
    { toolName: "bash", input: { command: 'git commit -m "allowed"' } },
    { cwd: guardRoot },
  ),
  undefined,
);
rmSync(guardRoot, { recursive: true, force: true });

console.log("ok: main branch guard self-test passed");
