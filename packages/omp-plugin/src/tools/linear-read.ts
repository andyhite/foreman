/**
 * `foreman_linear_read` — the only Linear surface any Foreman agent gets
 * (SPEC §3.5 item 1, principle 9). No write op and no write tool exists in
 * this file: the write client lives only inside the extension.
 */

import type { ExtensionAPI, ExtensionToolConfig, InferShape, ZodRawShape } from "@oh-my-pi/pi-coding-agent";
import type { Issue, IssueFilter } from "@foreman/core";
import {
  BLOCKED_FILTER,
  FOREMAN_STATE,
  INBOX_FILTER,
  NEEDS_INPUT_FILTER,
  RUNNING_FILTER,
  blockedByProjectRelations,
  blockingProjectRelations,
  inProject,
  inState,
  parseIdentifiers,
  withIdentifiers,
} from "@foreman/core";
import { getContextDigest, getEntry, getLinear, getProductDigest } from "../runtime.ts";

/**
 * A `view` row. Deliberately not an `Issue`: a view is a scan surface, and a
 * full row costs ~2.6 KB once descriptions, relations, children, and comments
 * are folded in — fifty of them overflow the caller's tool-result budget and
 * get truncated mid-JSON, which is worse than useless. Shortlist here, then
 * pull full text for the handful that matter with `issues`.
 */
interface IssueRow {
  identifier: string;
  title: string;
  state: string;
  priority: number;
  estimate: number | null;
  labels: string[];
  project: { id: string; name: string } | null;
  assignee: string | null;
  updatedAt: string;
  url: string;
}

function issueRow(issue: Issue): IssueRow {
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    priority: issue.priority,
    estimate: issue.estimate,
    labels: issue.labels.map((label) => label.name),
    project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
    assignee: issue.assignee?.displayName ?? issue.assignee?.name ?? null,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

/*
 * `backlog` exists because triage dedupes against it: the `foreman-triage-inbox`
 * skill's required reads name "the existing backlog", and without this view the
 * only way to reach it was an unfiltered whole-team read.
 */
const SAVED_VIEWS: Record<string, () => IssueFilter> = {
  inbox: () => INBOX_FILTER,
  backlog: () => inState(FOREMAN_STATE.backlog),
  "needs-input": () => NEEDS_INPUT_FILTER,
  blocked: () => BLOCKED_FILTER,
  running: () => RUNNING_FILTER,
  ready: () => inState(FOREMAN_STATE.ready),
  "in-review": () => inState(FOREMAN_STATE.inReview),
};

const OPS = ["issue", "issues", "comments", "context", "project_context", "states", "labels", "teams", "team_roadmap", "project_labels", "view"] as const;

export function registerLinearReadTool(pi: ExtensionAPI): void {
  const shape = {
    op: pi.zod.enum(OPS).describe("Which read to perform."),
    id: pi.zod
      .string()
      .optional()
      .describe(
        "Depends on op: one issue identifier for \"issue\"/\"comments\"; one or more identifiers, whitespace- or comma-separated, for \"issues\"; a project id for \"project_context\"; a team id for \"states\"/\"labels\".",
      ),
    view: pi.zod
      .enum(["inbox", "backlog", "needs-input", "blocked", "running", "ready", "in-review"])
      .optional()
      .describe("Saved view name, required when op is \"view\"."),
    includeComments: pi.zod
      .boolean()
      .optional()
      .describe("Include comments on the returned issue(s). \"issue\" and \"issues\" only; \"view\" rejects it."),
    limit: pi.zod.number().int().positive().optional().default(50).describe("Max rows to return for \"view\". Ignored by every other op."),
  } satisfies ZodRawShape;

  const config: ExtensionToolConfig<typeof shape> = {
    name: "foreman_linear_read",
    label: "Linear (read)",
    description:
      "Read Linear issues, comments, project context, workflow states, labels, teams, the team roadmap, and saved views. Read-only. " +
      "Resolve a whole batch of issues in one call with \"issues\" and a space-separated id list. " +
      "Scan with \"view\" (compact rows), then pull full text for the shortlist with \"issues\". " +
      "\"team_roadmap\" is the only op that returns candidate projects with their real Linear ids.",
    parameters: pi.zod.object(shape),
    approval: "read",
    /*
     * Essential, not the extension default of `discoverable`. omp's `tools.xdev`
     * layer (on by default) demotes every discoverable tool into an `xd://`
     * device in any session that holds `write` and does not name the tool in an
     * explicit allowlist — which is exactly the operator's own session that runs
     * every `/foreman:*` command. A demoted tool leaves the model's tool list
     * entirely, so the commands, agents, and skills that name this tool
     * directly ("resolve the project via `foreman_linear_read`") would point at
     * something that session cannot see, and the dispatch burns its opening
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
        /*
         * `id` is required. This op used to accept it and silently ignore it,
         * filtering on nothing: a dispatch asking for its ten-issue batch got
         * every issue in the team instead, overflowed the tool-result budget,
         * and paid twice for the same rows re-reading the artifact. A bare
         * "every issue in the team" read is what the saved views are for.
         */
        const identifiers = parseIdentifiers(params.id ?? "");
        if (identifiers.length === 0) {
          return errorResult(
            "op \"issues\" requires \"id\": one or more issue identifiers, whitespace- or comma-separated (\"PLT-183 PLT-143\"). For every issue in a queue, use op \"view\".",
          );
        }
        const issues = await linear.issues({
          filter: withIdentifiers(identifiers),
          limit: identifiers.length,
          includeComments: params.includeComments,
        });
        /*
         * A batch that comes back short means the caller named an issue that
         * moved team, was deleted, or was mistyped. Returning the survivors
         * alone would let a triage run drop an item without anyone noticing.
         */
        const found = new Set(issues.map((issue) => issue.identifier));
        return jsonResult({
          issues,
          requested: identifiers,
          missing: identifiers.filter((identifier) => !found.has(identifier)),
        });
      }
      if (params.op === "comments") {
        if (!params.id) return errorResult("op \"comments\" requires \"id\".");
        return jsonResult(await linear.comments(params.id));
      }
      if (params.op === "context") {
        return jsonResult({ digest: await getProductDigest() });
      }
      if (params.op === "project_context") {
        if (!params.id) return errorResult("op \"project_context\" requires \"id\" (project id).");
        /*
         * `hasIssues` answers `/foreman:plan`'s gate — "zero issues in any
         * state" — which nothing else can: no saved view is project-scoped,
         * and Linear's `IssueConnection` exposes no `totalCount` (measured),
         * so a count would mean paginating the whole project. One row is
         * enough to decide, and the gate is a boolean.
         */
        try {
          const [digest, seeded] = await Promise.all([
            getContextDigest(params.id),
            linear.issues({ filter: inProject(params.id), limit: 1 }),
          ]);
          return jsonResult({ digest, hasIssues: seeded.length > 0 });
        } catch (error) {
          /*
           * Linear answers a non-project UUID with a bare "Entity not found:
           * Project", which reads like a missing project rather than the
           * wrong kind of id. A terminated triage run spent four calls on
           * that message — team id, then an unrelated project id — before
           * giving up, so say what the caller is actually holding.
           */
          const message = error instanceof Error ? error.message : String(error);
          if (!/entity not found/i.test(message)) throw error;
          return errorResult(
            `No project ${params.id}. "id" MUST be a Linear project id: a team id or an issue identifier will not resolve. ` +
              "List this team's projects and their ids with op \"team_roadmap\". Triage-state issues have no project at all, so there is no project context to read for one.",
          );
        }
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
      if (params.op === "team_roadmap") {
        const projects = await linear.projects(getEntry().team);
        // One `projectRelations` call per project: nesting both relation
        // connections under a `projects(first: 250)` query exceeds Linear's
        // query-complexity ceiling (measured against the live API), so this
        // is N+1 queries rather than one, by necessity.
        const roadmap = await Promise.all(
          projects.map(async (project) => {
            const relations = await linear.projectRelations(project.id);
            return {
              id: project.id,
              name: project.name,
              status: project.status ?? null,
              startDate: project.startDate ?? null,
              targetDate: project.targetDate ?? null,
              blockedBy: blockedByProjectRelations(relations).map((relation) => relation.other),
              blocks: blockingProjectRelations(relations).map((relation) => relation.other),
            };
          }),
        );
        return jsonResult({ projects: roadmap });
      }
      if (params.op === "project_labels") {
        return jsonResult(await linear.projectLabels());
      }

      // op === "view"
      if (!params.view) return errorResult("op \"view\" requires \"view\".");
      if (params.includeComments) {
        return errorResult("op \"view\" returns compact rows and carries no comments. Shortlist here, then use op \"issues\" with the identifiers you want.");
      }
      const buildFilter = SAVED_VIEWS[params.view];
      if (!buildFilter) return errorResult(`Unknown view "${params.view}".`);
      const fetchedView = await linear.issues({ filter: buildFilter(), limit: params.limit + 1 });
      const viewTruncated = fetchedView.length > params.limit;
      const viewIssues = viewTruncated ? fetchedView.slice(0, params.limit) : fetchedView;
      return jsonResult({ issues: viewIssues.map(issueRow), truncated: viewTruncated, total: viewIssues.length });
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
