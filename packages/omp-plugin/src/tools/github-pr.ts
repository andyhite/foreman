/**
 * `foreman_github_pr` — the single mutation tool any Foreman agent holds,
 * because the PR must exist before `foreman-implement` yields (SPEC §7.3,
 * §13.2). Refuses `create` when the repo's resolved config sets
 * `pr.required: false`, since direct-branch mode expects the branch pushed
 * with no PR.
 */

import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionToolConfig, InferShape, ZodRawShape } from "@oh-my-pi/pi-coding-agent";
import { getEntry, getGitHub } from "../runtime.ts";

const OPS = ["create", "view"] as const;

export function registerGitHubPrTool(pi: ExtensionAPI): void {
  const shape = {
    op: pi.zod.enum(OPS),
    repoPath: pi.zod.string().describe("Absolute path to the repo (the worktree's origin repo, not the worktree itself)."),
    title: pi.zod.string().optional().describe("PR title. Required for op \"create\"."),
    body: pi.zod.string().optional().describe("PR body. Required for op \"create\"."),
    head: pi.zod.string().optional().describe("Head branch. Required for both ops."),
    base: pi.zod.string().optional().describe("Base branch. Required for op \"create\"."),
    draft: pi.zod.boolean().optional().describe("Open as a draft PR."),
  } satisfies ZodRawShape;

  const config: ExtensionToolConfig<typeof shape> = {
    name: "foreman_github_pr",
    label: "GitHub PR",
    description: "Create or view the pull request for a branch. The one mutation tool any Foreman agent holds.",
    parameters: pi.zod.object(shape),
    approval: "write",
    execute: async (_toolCallId, params: InferShape<typeof shape>) => {
      const entry = getEntry();
      let repoPath: string;
      try {
        repoPath = realpathSync(params.repoPath);
      } catch {
        return errorResult(`repoPath "${params.repoPath}" does not exist.`);
      }
      if (repoPath !== realpathSync(entry.repoPath)) {
        return errorResult(`repoPath must resolve to Foreman's registered repository (${entry.repoPath}).`);
      }
      const github = getGitHub();
      if (params.op === "view") {
        if (!params.head) return errorResult("op \"view\" requires \"head\".");
        const pr = await github.prForBranch(repoPath, params.head);
        return jsonResult(pr);
      }

      // op === "create"
      const repoSettings = entry;
      if (!repoSettings.pr.required) {
        return errorResult(
          "This repo sets pr.required: false (direct-branch mode). Push the branch instead of opening a PR.",
        );
      }
      if (!params.title || !params.body || !params.head || !params.base) {
        return errorResult("op \"create\" requires \"title\", \"body\", \"head\", and \"base\".");
      }

      const pr = await github.createPr(repoPath, {
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: params.draft ?? repoSettings.pr.draft,
      });
      return jsonResult(pr);
    },
  };

  pi.registerTool(config);
}

function jsonResult(data: unknown): { content: Array<{ type: string; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: { data } };
}

function errorResult(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text: message }], isError: true };
}
