/**
 * `foreman_linear_read` — the only Linear surface any Foreman agent gets
 * (SPEC §3.5 item 1, principle 9). No write op and no write tool exists in
 * this file: the write client lives only inside the extension.
 */

import type { ExtensionAPI, ExtensionToolConfig, InferShape, ZodRawShape } from "@oh-my-pi/pi-coding-agent";
import type { IssueFilter } from "@foreman/core";
import {
  BLOCKED_DEPS_FILTER,
  BLOCKED_HUMAN_FILTER,
  INBOX_FILTER,
  IN_FLIGHT_FILTER,
  PROPOSALS_FILTER,
  readyFilter,
} from "@foreman/core";
import { getContextDigest, getLinear } from "../runtime.ts";

const SAVED_VIEWS: Record<string, () => IssueFilter> = {
  inbox: () => INBOX_FILTER,
  "blocked-human": () => BLOCKED_HUMAN_FILTER,
  "blocked-deps": () => BLOCKED_DEPS_FILTER,
  proposals: () => PROPOSALS_FILTER,
  ready: () => readyFilter(),
  "in-flight": () => IN_FLIGHT_FILTER,
};

const OPS = ["issue", "issues", "comments", "project_context", "states", "labels", "teams", "view"] as const;

export function registerLinearReadTool(pi: ExtensionAPI): void {
  const shape = {
    op: pi.zod.enum(OPS).describe("Which read to perform."),
    id: pi.zod.string().optional().describe("Issue identifier, project id, or team id, depending on op."),
    view: pi.zod
      .enum(["inbox", "blocked-human", "blocked-deps", "proposals", "ready", "in-flight"])
      .optional()
      .describe("Saved view name, required when op is \"view\"."),
    includeComments: pi.zod.boolean().optional().describe("Include comments on the returned issue(s)."),
    limit: pi.zod.number().int().positive().optional().default(50).describe("Max issues to return for \"issues\" or \"view\"."),
  } satisfies ZodRawShape;

  const config: ExtensionToolConfig<typeof shape> = {
    name: "foreman_linear_read",
    label: "Linear (read)",
    description:
      "Read Linear issues, comments, project context, workflow states, labels, teams, and saved views. Read-only.",
    parameters: pi.zod.object(shape),
    approval: "read",
    /*
     * Essential, not the extension default of `discoverable`. omp's `tools.xdev`
     * layer (on by default) demotes every discoverable tool into an `xd://`
     * device in any session that holds `write` and does not name the tool in an
     * explicit allowlist — which is exactly the supervisor session that runs
     * every `/foreman:*` command. A demoted tool leaves the model's tool list
     * entirely, so the commands, agents, and skills that name this tool
     * directly ("resolve the project via `foreman_linear_read`") would point at
     * something the supervisor cannot see, and the dispatch burns its opening
     * turns hunting for the name instead of reading Linear.
     *
     * `essential` also keeps the full parameter schema in the prompt:
     * `tools.xdevDocs` defaults to `"builtins"`, which gives an external device
     * a one-line summary and no schema at all.
     */
    loadMode: "essential",
    execute: async (_toolCallId, params: InferShape<typeof shape>) => {
      const linear = getLinear();

      if (params.op === "issue") {
        if (!params.id) return errorResult("op \"issue\" requires \"id\".");
        const issue = await linear.issue(params.id, { includeComments: params.includeComments });
        return jsonResult(issue);
      }
      if (params.op === "issues") {
        const fetched = await linear.issues({ limit: params.limit + 1, includeComments: params.includeComments });
        const truncated = fetched.length > params.limit;
        const issues = truncated ? fetched.slice(0, params.limit) : fetched;
        return jsonResult({ issues, truncated, total: issues.length });
      }
      if (params.op === "comments") {
        if (!params.id) return errorResult("op \"comments\" requires \"id\".");
        return jsonResult(await linear.comments(params.id));
      }
      if (params.op === "project_context") {
        if (!params.id) return errorResult("op \"project_context\" requires \"id\" (project id).");
        const digest = await getContextDigest(params.id);
        return jsonResult({ digest });
      }
      if (params.op === "states") {
        if (!params.id) return errorResult("op \"states\" requires \"id\" (team id).");
        return jsonResult(await linear.workflowStates(params.id));
      }
      if (params.op === "labels") {
        return jsonResult(await linear.labels(params.id));
      }
      if (params.op === "teams") {
        return jsonResult(await linear.teams());
      }

      // op === "view"
      if (!params.view) return errorResult("op \"view\" requires \"view\".");
      const buildFilter = SAVED_VIEWS[params.view];
      if (!buildFilter) return errorResult(`Unknown view "${params.view}".`);
      const fetchedView = await linear.issues({ filter: buildFilter(), limit: params.limit + 1 });
      const viewTruncated = fetchedView.length > params.limit;
      const viewIssues = viewTruncated ? fetchedView.slice(0, params.limit) : fetchedView;
      return jsonResult({ issues: viewIssues, truncated: viewTruncated, total: viewIssues.length });
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
