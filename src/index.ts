import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import {
  analyzeShellCommand,
  decideMainBranchGuard,
  discoverForemanConfig,
  type ForemanConfigFileSystem,
} from "./main-branch-guard.js";

/**
 * Foreman — an omp extension that packages a GitHub-issue-tracker-driven dev
 * workflow (ideas -> epics/tasks -> worktrees -> stacked PRs -> operator
 * merge) as reusable commands, skills, and agents.
 *
 * This module is intentionally thin. The workflow itself lives in the
 * sibling `commands/`, `skills/`, `agents/`, and `rules/` directories, which
 * omp discovers automatically once this extension is loaded. Its only runtime
 * policy is a `tool_call` hook that prevents an agent from mutating a
 * configured default branch; it does not affect human terminal commands.
 */

const fileSystem: ForemanConfigFileSystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
};
export default function foreman(pi: ExtensionAPI) {
  pi.setLabel("Foreman — issue-tracker-driven dev workflow");

  pi.on("session_start", async (_event, ctx) => {
    const configPath = join(ctx.cwd, ".omp", "foreman.json");
    if (existsSync(configPath)) return;
    if (!existsSync(join(ctx.cwd, ".git"))) return;
    ctx.ui.notify(
      "Foreman: no .omp/foreman.json in this repo yet — run /foreman:init to wire up GitHub labels + project board tracking.",
      "info",
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const analysis = analyzeShellCommand(event.input.command, ctx.cwd);
    if (!analysis.apparentMutation) return undefined;

    const config = discoverForemanConfig(analysis.cwd, fileSystem);
    const preBranchDecision = decideMainBranchGuard({ analysis, config, branch: undefined });
    if (preBranchDecision) return preBranchDecision;
    if (config.kind !== "configured") return undefined;

    const result = await pi.exec("git", ["branch", "--show-current"], { cwd: analysis.cwd });
    if (result.code !== 0) return undefined;

    const branch = result.stdout.trim();
    if (!branch) return undefined;
    return decideMainBranchGuard({ analysis, config, branch });
  });
}
