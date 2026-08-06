import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Foreman — an omp extension that packages a GitHub-issue-tracker-driven dev
 * workflow (ideas -> epics/tasks -> worktrees -> stacked PRs -> operator
 * merge) as reusable commands, skills, and agents.
 *
 * This module is intentionally thin. The workflow itself lives in the
 * sibling `commands/`, `skills/`, `agents/`, and `rules/` directories, which
 * omp discovers automatically once this extension is loaded (see the
 * `omp-plugins` capability provider). The only runtime behavior here is a
 * one-line nudge toward `/foreman:init` when a project hasn't been wired up
 * yet.
 */
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
}
