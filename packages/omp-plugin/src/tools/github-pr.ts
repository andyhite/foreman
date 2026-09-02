/**
 * `foreman_github_pr` — the single mutation tool any Foreman agent holds,
 * because the PR must exist before `foreman-implement` yields (SPEC §7.3,
 * §13.2). Refuses `create` when the repo's resolved config sets
 * `pr.required: false`, since direct-branch mode expects the branch pushed
 * with no PR.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolConfig, InferShape, ZodRawShape } from "@oh-my-pi/pi-coding-agent";
import { nodeRunner } from "@foreman/core";
import { getEntry, getGitHub } from "../runtime.ts";

const OPS = ["create", "view"] as const;

/** Resolves `git rev-parse --git-common-dir` for `repoPath`, absolute and realpath'd so a worktree and its
 * origin repo compare equal regardless of a relative `.git` answer or a symlinked path component. */
async function gitCommonDir(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await nodeRunner.run(["git", "rev-parse", "--git-common-dir"], { cwd: repoPath });
    const raw = stdout.trim();
    const absolute = isAbsolute(raw) ? raw : resolve(repoPath, raw);
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

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
    // Essential for the same reason as `foreman_linear_read` (see the comment
    // in `linear-read.ts`): a `discoverable` registration is demoted to an
    // `xd://` device in any session holding `write` that does not name the tool
    // in an explicit allowlist, and every instruction naming this tool would
    // then point at something the caller cannot see in its tool list.
    loadMode: "essential",
    execute: async (_toolCallId, params: InferShape<typeof shape>) => {
      const entry = getEntry();
      let repoPath: string;
      try {
        repoPath = realpathSync(params.repoPath);
      } catch {
        return errorResult(`repoPath "${params.repoPath}" does not exist.`);
      }
      // `repoPath` is only ever used as the `gh` working directory, so a
      // Foreman worktree (whose git common dir points back at the registered
      // repo's `.git`) is just as valid as the repo root itself — implement
      // always runs from the worktree and has no other path to offer.
      if (repoPath !== realpathSync(entry.repoPath)) {
        const [worktreeCommonDir, repoCommonDir] = await Promise.all([gitCommonDir(repoPath), gitCommonDir(entry.repoPath)]);
        if (worktreeCommonDir === null || worktreeCommonDir !== repoCommonDir) {
          return errorResult(`repoPath must resolve to Foreman's registered repository (${entry.repoPath}) or one of its worktrees.`);
        }
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
