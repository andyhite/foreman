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

function decision(command: string, branch: string | undefined, discovered = config) {
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
// `git branch` is judged by the ref it writes, never by what is checked out:
// deleting a topic branch from main leaves main untouched.
assert.equal(decision("git branch -D stale-topic", "main"), undefined);
assert.equal(decision("git branch -d stale-topic", "main"), undefined);
assert.equal(decision("git branch", "main"), undefined);
assert.equal(decision("git branch feat/new", "main"), undefined);
assert.equal(decision("git branch --contains main", "main"), undefined);
assert.equal(decision("git branch --merged main -d stale", "main"), undefined);
assert.ok(decision("git branch -D main", "feat/guard"));
assert.ok(decision("git branch --delete main", "feat/guard"));
assert.ok(decision("git branch -D refs/heads/main", "feat/guard"));
assert.ok(decision("git branch -qD main", "feat/guard"));

// Creation writes a ref too, so it is judged by the same invariant.
assert.ok(decision("git branch main origin/main", "feat/guard"));
assert.ok(decision("git branch main", "feat/guard"));

// `-r` confines the operation to refs/remotes/*, which is never local main.
assert.equal(decision("git branch -dr origin/main", "main"), undefined);
assert.equal(decision("git branch -dr main", "feat/guard"), undefined);
assert.equal(decision("git branch --remotes --delete origin/main", "main"), undefined);

// With a listing flag the positionals are match patterns, not a new branch.
assert.equal(decision("git branch -a", "main"), undefined);
assert.equal(decision("git branch -a main", "main"), undefined);
assert.equal(decision("git branch --list main", "main"), undefined);
assert.equal(decision("git branch -v main", "main"), undefined);
assert.equal(decision("git branch -vv", "main"), undefined);
assert.equal(decision("git branch -av main", "feat/guard"), undefined);
assert.equal(decision("git branch --show-current", "main"), undefined);
assert.equal(decision("git branch -u origin/main", "main"), undefined);
assert.equal(decision("git branch --format=%(refname) main", "main"), undefined);
assert.equal(decision("git branch --contains=HEAD main", "main"), undefined);
assert.equal(decision("git branch --sort=-committerdate main", "main"), undefined);
assert.equal(decision("git branch --set-upstream-to=origin/main main", "main"), undefined);
assert.equal(decision("git branch -i --list MAIN", "main"), undefined);
// Creation-compatible options keep the inference alive.
assert.ok(decision("git branch -q main origin/main", "feat/guard"));
assert.ok(decision("git branch --track main origin/main", "feat/guard"));
assert.ok(decision("git branch --track=inherit main origin/main", "feat/guard"));
assert.ok(decision("git branch --no-track main origin/main", "feat/guard"));
assert.ok(decision("git branch --create-reflog main origin/main", "feat/guard"));
assert.ok(decision("git branch --no-create-reflog main origin/main", "feat/guard"));
assert.ok(decision("git branch --recurse-submodules main origin/main", "feat/guard"));
assert.ok(decision("git branch -q --create-reflog --track main origin/main", "feat/guard"));

// Renames and force-writes reach the same ref by another route.
assert.ok(decision("git branch -m main old-main", "feat/guard"));
assert.ok(decision("git branch -M renamed", "main"));
assert.equal(decision("git branch -m old new", "main"), undefined);
assert.ok(decision("git branch -f main origin/main", "feat/guard"));
assert.ok(decision("git branch -C topic main", "feat/guard"));
assert.equal(decision("git branch -c main backup", "main"), undefined);

// A detached HEAD has no current branch, which used to permit everything.
assert.ok(decision("git branch -D main", undefined));
assert.ok(decision("git push origin HEAD:main", undefined));
assert.equal(decision("git branch -D stale-topic", undefined), undefined);
assert.equal(decision('git commit -m "detached"', undefined), undefined);

// A harmless first fragment must not mask a later one.
assert.ok(decision('git branch -D stale-topic && git commit -m "x"', "main"));
assert.ok(decision("git branch -D stale-topic && git push origin main", "feat/guard"));
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

// The regression that motivated this: through the real hook, on the default
// branch, deleting an unrelated topic branch must go through — while the
// default branch's own ref stays protected on the same path.
branchForHook = "main";
assert.equal(
  await toolCall(
    { toolName: "bash", input: { command: "git branch -D stale-topic" } },
    { cwd: guardRoot },
  ),
  undefined,
);
assert.ok(
  await toolCall(
    { toolName: "bash", input: { command: "git branch -D main" } },
    { cwd: guardRoot },
  ),
);
rmSync(guardRoot, { recursive: true, force: true });

console.log("ok: main branch guard self-test passed");
